#!/usr/bin/env bash
# Sesli Oda yayını (sunucuda). Kurulumda root'a ait bir kopya olarak /usr/local/sbin/sesli-oda-yayin'e konur;
# depodaki bu dosyanın sonraki değişiklikleri kendiliğinden devreye girmez (elle yeniden kopyalanır).
#
#   sesli-oda-yayin           origin/main'deki son commit'i yayınlar (zamanlayıcı dakikada bir çağırır).
#                             Zaten yayında ve sağlıklıysa ya da konteyner hâlâ açılıyorsa sessizce çıkar.
#   sesli-oda-yayin <sha>     O commit'i yayınlar (geri alma ya da başarısız commit'i yeniden deneme).
#                             main'in geçmişinde olmalı.
#
# root olarak çalışır (docker için); git adımları ayrıcalıksız $GIT_USER kullanıcısıyla yapılır.
# Compose dosyası ve Dockerfile depodan değil, root'a ait onaylı kopyalardan ($COMPOSE_FILE, $DOCKERFILE)
# okunur: main'e push yalnız imaja giren dosyaları ve package-lock.json'un sabitlediği paketleri değiştirir;
# konteynerin yetkilerini (kullanıcı, bağlamalar, ağ) ya da kurulum adımlarını değiştiremez. Depodaki
# deploy/compose.yml ya da deploy/Dockerfile kurulu kopyadan farklıysa yine kurulu kopya kullanılır ve commit
# başına bir uyarı yazılır. Derleme bağlamı çalışma ağacı değil, commit'in `git archive` çıktısıdır (.git yok,
# ayrıcalıksız kullanıcı denetimle derleme arasında dosyaları değiştiremez, bağlamdaki sembolik bağlar dışarı
# çıkamaz); kurulu Dockerfile bu arşive eklenir.
#
# Yeni imaj sha etiketiyle başlatılır; $HEALTH_WAIT saniyede sağlıklı açılırsa "current" etiketini alır.
# Kurulamaz, başlatılamaz ya da sağlıklı açılmazsa "current" (önceki sağlıklı sürüm) yeniden başlatılır ve betik
# hata koduyla çıkar. Başarısız commit kaydedilir; zamanlayıcı onu tekrar tekrar denemez. Site kapalı kaldıysa
# (iki sürüm de açılmadı) her turda "SİTE KAPALI" yazar ve hata koduyla çıkar.
set -euo pipefail

BASE_DIR=${BASE_DIR:-/srv/sesli-oda}
APP_DIR=${APP_DIR:-$BASE_DIR/app}                 # deponun git kopyası ($GIT_USER'a ait)
COMPOSE_FILE=${COMPOSE_FILE:-$BASE_DIR/compose.yml} # onaylı compose kopyası (root, 644)
DOCKERFILE=${DOCKERFILE:-$BASE_DIR/Dockerfile}    # onaylı Dockerfile kopyası (root, 644)
ENV_FILE=${ENV_FILE:-$BASE_DIR/.env}              # sırlar (root, 600)
STATE_DIR=${STATE_DIR:-$BASE_DIR/state}           # başarısız / sabitlenmiş commit kayıtları (root)
LOCK_FILE=${LOCK_FILE:-/run/sesli-oda-yayin/lock} # dizin root 700 (birimde RuntimeDirectory)
GIT_USER=${GIT_USER-sesli-oda}                    # boşsa git çalıştıranın kendisiyle çalışır (yalnız deneme)
PROJECT=sesli-oda                                 # compose proje adı
IMAGE=sesli-oda-app                               # imaj adı; etiketler: <kısa sha> ve current (son sağlıklı)
BRANCH=main
HEALTH_WAIT=${HEALTH_WAIT:-60}                    # sn; yeni konteynerin sağlıklı olması için süre
HEALTH_POLL=${HEALTH_POLL:-2}                     # sn
KEEP_IMAGES=3                                     # tutulan son imaj sayısı (sha etiketli)
REV_LABEL=org.opencontainers.image.revision
CTX_DOCKERFILE=Dockerfile.sesli-oda-kurulu        # kurulu Dockerfile'ın derleme arşivindeki adı

log() { echo "sesli-oda-yayin: $*"; }

git_app() {
  if [[ -n $GIT_USER ]]; then
    setpriv --reuid="$GIT_USER" --regid="$GIT_USER" --init-groups --reset-env -- git -C "$APP_DIR" "$@"
  else
    git -C "$APP_DIR" "$@"
  fi
}

compose() {
  docker compose --project-name "$PROJECT" -f "$COMPOSE_FILE" --project-directory "$APP_DIR" \
    --env-file "$ENV_FILE" "$@"
}

# İmajın (etiket ya da kimlik) kurulduğu commit; yoksa boş.
revision_of() {
  docker image inspect -f "{{index .Config.Labels \"$REV_LABEL\"}}" "$1" 2>/dev/null || true
}

# app konteynerinin kimliği; yoksa boş.
app_container() {
  compose ps -a -q app 2>/dev/null | head -n 1 || true
}

# Çalışmıyorsa konteyner durumu (restarting, exited, created...), çalışıyorsa sağlık durumu
# (healthy, starting, unhealthy); konteyner yoksa none. Sürekli çöken konteyner "starting" görünmez.
app_health() {
  local id
  id=$(app_container)
  if [[ -z $id ]]; then echo none; return; fi
  docker inspect -f '{{if ne .State.Status "running"}}{{.State.Status}}{{else if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' \
    "$id" 2>/dev/null || echo none
}

# Çalışan app konteynerinin commit'i; yoksa boş.
running_revision() {
  local id image
  id=$(app_container)
  if [[ -z $id ]]; then return 0; fi
  image=$(docker inspect -f '{{.Image}}' "$id" 2>/dev/null || true)
  if [[ -n $image ]]; then revision_of "$image"; fi
}

wait_healthy() {
  local waited=0 status
  while (( waited < HEALTH_WAIT )); do
    status=$(app_health)
    case $status in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    sleep "$HEALTH_POLL"
    waited=$(( waited + HEALTH_POLL ))
  done
  return 1
}

# start_app <imaj etiketi>: app'i o imajla yeniden yaratır (kısa kesinti; iki sunucu aynı anda çalışmaz).
start_app() {
  APP_TAG=$1 compose up -d --no-deps --force-recreate app
}

# Son $KEEP_IMAGES sha etiketli imaj kalır; daha eskiler (yalnız bu projenin imajları) silinir.
prune_images() {
  local tag n=0
  # docker image ls en yeniden en eskiye sıralar
  for tag in $(docker image ls "$IMAGE" --format '{{.Tag}}'); do
    [[ $tag == current || $tag == '<none>' ]] && continue
    n=$(( n + 1 ))
    if (( n > KEEP_IMAGES )); then
      if docker image rm "$IMAGE:$tag" >/dev/null 2>&1; then log "eski imaj silindi: $IMAGE:$tag"; fi
    fi
  done
}

mark() { # mark <dosya> <sha>
  mkdir -p "$STATE_DIR"
  echo "$2" > "$STATE_DIR/$1"
}
marked() { # marked <dosya> <sha>: o commit zaten kayıtlı mı
  [[ -f $STATE_DIR/$1 && $(cat "$STATE_DIR/$1") == "$2" ]]
}

# Site açık değil: her turda görünür bir satır ve hata kodu.
site_down() {
  log "SİTE KAPALI: $* Elle: sesli-oda-yayin <sha>; günlük: journalctl -t sesli-oda-sesli-oda-app-1"
  exit 1
}

# Depodaki kopya (deploy/<ad>) hedef commit'te kurulu kopyadan farklıysa commit başına bir kez uyarır.
# installed_note <depodaki yol> <kurulu dosya> <görünen ad> <durum anahtarı>
installed_note() {
  if git_app show "$target:$1" 2>/dev/null | cmp -s - "$2"; then return 0; fi
  if marked "$4" "$target"; then return 0; fi
  mark "$4" "$target"
  log "UYARI: $3 değişti, kurulu kopya kullanılıyor: elle güncelle (depodaki $1 @ $short -> $2," \
    "gözden geçirip kopyala)."
}

# İmajı commit'in temiz arşivinden ve kurulu Dockerfile'dan kurar. (Koşul içinde çağrılır: set -e burada
# işlemez, her adım elle denetlenir.)
build_image() {
  local work rc=0
  mkdir -p -m 700 "$STATE_DIR/build"
  work=$(mktemp -d "$STATE_DIR/build/yayin.XXXXXX") || return 1
  if ! git_app archive --format=tar "$target" > "$work/ctx.tar"; then
    log "HATA: git archive başarısız."
    rc=1
  elif tar -tf "$work/ctx.tar" | grep -qxF "$CTX_DOCKERFILE"; then
    log "HATA: depoda $CTX_DOCKERFILE adlı bir dosya var; kurulu Dockerfile ile çakışır."
    rc=1
  # Kurulu Dockerfile arşive sabit bir adla eklenir (tar -r yeniden adlandıramaz: önce kopyası).
  elif ! cp "$DOCKERFILE" "$work/$CTX_DOCKERFILE" || ! tar -rf "$work/ctx.tar" -C "$work" "$CTX_DOCKERFILE"; then
    log "HATA: derleme arşivi hazırlanamadı."
    rc=1
  elif ! docker build --pull --quiet --label "$REV_LABEL=$target" -t "$IMAGE:$short" \
      -f "$CTX_DOCKERFILE" - < "$work/ctx.tar" >/dev/null; then
    rc=1
  fi
  rm -rf "$work"
  return "$rc"
}

# ---------- Ana akış ----------

manual=${1:-}
if [[ -n $manual && ! $manual =~ ^[0-9a-f]{7,40}$ ]]; then
  log "HATA: geçersiz commit: $manual (7-40 karakter onaltılık sha bekleniyor)"
  exit 2
fi

lock_dir=$(dirname "$LOCK_FILE")
if [[ ! -d $lock_dir ]]; then mkdir -p -m 700 "$lock_dir"; fi # elle çağrı (zamanlayıcıda systemd açar)
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  if [[ -n $manual ]]; then
    log "HATA: başka bir yayın sürüyor; biraz sonra tekrar dene."
    exit 1
  fi
  exit 0 # zamanlayıcı: bir sonraki turda denenir
fi

for f in "$COMPOSE_FILE" "$DOCKERFILE"; do
  if [[ ! -f $f ]]; then
    log "HATA: kurulu kopya yok: $f (README: ilk kurulum)."
    exit 1
  fi
done

git_app fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
main_head=$(git_app rev-parse "origin/$BRANCH^{commit}")
if [[ -n $manual ]]; then
  if ! target=$(git_app rev-parse --verify --quiet "$manual^{commit}"); then
    log "HATA: commit bulunamadı: $manual"
    exit 2
  fi
  if ! git_app merge-base --is-ancestor "$target" "origin/$BRANCH"; then
    log "HATA: $manual $BRANCH dalının geçmişinde değil; yayınlanmadı."
    exit 2
  fi
else
  target=$main_head
fi
short=${target:0:12}

running=$(running_revision)
health=$(app_health)

if [[ -z $manual ]]; then
  # Zamanlayıcı turu: yeni bir şey yoksa, konteyner açılıyorsa ya da commit daha önce başarısız olduysa
  # (ya da elle eski bir sürüme dönüldüyse) hiçbir şey yeniden başlatılmaz.
  case $health in
    starting) exit 0 ;; # açılıyor (sağlık denetimi sürüyor); bir sonraki turda bakılır
    healthy)
      if [[ $running == "$target" ]] || marked failed "$target" || marked pinned "$target"; then exit 0; fi ;;
    *)
      # unhealthy, restarting (çöküp duruyor), exited, none...
      if [[ $running == "$target" ]]; then
        site_down "yayındaki ${short} sağlıksız (durum: $health); aynı sürüm otomatik olarak yeniden yaratılmıyor."
      fi
      if marked failed "$target" || marked pinned "$target"; then
        site_down "app konteyneri çalışmıyor ya da sağlıksız (durum: $health, yayındaki: ${running:0:12}," \
          "main: $short daha önce başarısız)."
      fi ;;
  esac
elif [[ $running == "$target" && $health == healthy ]]; then
  log "$short zaten yayında ve sağlıklı."
  exit 0
fi

prev_image=$(docker image inspect -f '{{.Id}}' "$IMAGE:current" 2>/dev/null || true)
prev_rev=""
if [[ -n $prev_image ]]; then prev_rev=$(revision_of "$prev_image"); fi

restore_checkout() {
  if [[ -n $prev_rev ]]; then git_app checkout --quiet --force --detach "$prev_rev"; fi
}

log "yayın başlıyor: $short (yayındaki: ${running:0:12}, durum: $health)"
git_app checkout --quiet --force --detach "$target"

if [[ $(revision_of "$IMAGE:$short") == "$target" ]]; then
  log "$IMAGE:$short zaten var; yeniden kurulmadı." # geri almada hızlı dönüş
elif ! build_image; then
  mark failed "$target"
  restore_checkout
  log "HATA: $short imajı kurulamadı; yayındaki sürüm aynen çalışıyor."
  exit 1
fi
installed_note deploy/compose.yml "$COMPOSE_FILE" compose compose-uyarildi
installed_note deploy/Dockerfile "$DOCKERFILE" Dockerfile dockerfile-uyarildi

if start_app "$short" && wait_healthy; then
  docker tag "$IMAGE:$short" "$IMAGE:current"
  # İlk kurulumda tüneli açar; çalışıyorsa dokunmaz. APP_TAG ve --no-deps: compose app'i (bağımlılık) farklı
  # imaj etiketi görüp ikinci kez yeniden yaratmasın.
  if ! APP_TAG=$short compose up -d --no-deps tunnel; then
    log "HATA: tunnel konteyneri başlatılamadı (uygulama $short çalışıyor)."
  fi
  rm -f "$STATE_DIR/failed" "$STATE_DIR/pinned"
  log "yayında: $short"
  if [[ $target != "$main_head" ]]; then
    # Geri alma: zamanlayıcı main'deki sürümü hemen geri getirmesin; main'e yeni commit gelince yayın sürer.
    mark pinned "$main_head"
    log "otomatik yayın main'e yeni bir commit gelene kadar durdu (main: ${main_head:0:12})."
  fi
  prune_images
  exit 0
fi

mark failed "$target"
log "HATA: $short başlatılamadı ya da $HEALTH_WAIT saniyede sağlıklı açılmadı (durum: $(app_health)); son günlük satırları:"
docker logs --tail 30 "$(app_container)" 2>&1 | sed 's/^/  | /' || true
if [[ -z $prev_image ]]; then
  site_down "ilk yayın $short açılmadı; dönülecek önceki sürüm yok."
fi
log "önceki sürüme dönülüyor: ${prev_rev:0:12}"
restore_checkout
if start_app current && wait_healthy; then
  log "HATA: $short yayınlanamadı; önceki sürüm ${prev_rev:0:12} yeniden çalışıyor."
  exit 1
fi
site_down "$short yayınlanamadı ve önceki sürüm ${prev_rev:0:12} de açılmadı (durum: $(app_health))."
