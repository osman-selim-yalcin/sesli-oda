#!/usr/bin/env bash
# Sesli Oda yayını (sunucuda). Kurulumda root'a ait bir kopya olarak /usr/local/sbin/sesli-oda-yayin'e konur;
# depodaki bu dosyanın sonraki değişiklikleri kendiliğinden devreye girmez (elle yeniden kopyalanır).
#
#   sesli-oda-yayin           origin/main'deki son commit'i yayınlar (zamanlayıcı dakikada bir çağırır).
#                             Zaten yayındaysa ve sağlıklıysa sessizce çıkar.
#   sesli-oda-yayin <sha>     O commit'i yayınlar (geri alma ya da elle onay). main'in geçmişinde olmalı.
#
# root olarak çalışır (docker için); git adımları ayrıcalıksız $GIT_USER kullanıcısıyla yapılır.
# Yeni imaj kurulamaz ya da $HEALTH_WAIT saniyede sağlıklı açılmazsa önceki imaj geri konur ve betik hata
# koduyla çıkar. Başarısız commit kaydedilir; zamanlayıcı aynı commit'i tekrar tekrar denemez.
# Otomatik yayın deploy/compose.yml değişen bir commit'i yayınlamaz (compose dosyası konteynere host üzerinde
# yetki verebilir): gözden geçirilip elle `sesli-oda-yayin <sha>` ile yayınlanır.
set -euo pipefail

BASE_DIR=${BASE_DIR:-/srv/sesli-oda}
APP_DIR=${APP_DIR:-$BASE_DIR/app}                 # deponun git kopyası ($GIT_USER'a ait)
ENV_FILE=${ENV_FILE:-$BASE_DIR/.env}              # sırlar (root, 600)
STATE_DIR=${STATE_DIR:-$BASE_DIR/state}           # başarısız / bekletilen commit kayıtları (root)
LOCK_FILE=${LOCK_FILE:-/run/lock/sesli-oda-yayin.lock}
GIT_USER=${GIT_USER-sesli-oda}                    # boşsa git çalıştıranın kendisiyle çalışır (yalnız deneme)
PROJECT=sesli-oda                                 # compose proje adı
IMAGE=sesli-oda-app                               # imaj adı; etiketler: <kısa sha> ve current (yayındaki)
BRANCH=main
HEALTH_WAIT=${HEALTH_WAIT:-60}                    # sn; yeni konteynerin sağlıklı olması için süre
HEALTH_POLL=${HEALTH_POLL:-2}                     # sn
KEEP_IMAGES=3                                     # tutulan son imaj sayısı (sha etiketli)
REV_LABEL=org.opencontainers.image.revision

log() { echo "sesli-oda-yayin: $*"; }

git_app() {
  if [[ -n $GIT_USER ]]; then
    setpriv --reuid="$GIT_USER" --regid="$GIT_USER" --init-groups --reset-env -- git -C "$APP_DIR" "$@"
  else
    git -C "$APP_DIR" "$@"
  fi
}

compose() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$APP_DIR/deploy/compose.yml" "$@"
}

# İmajın (etiket ya da kimlik) kurulduğu commit; yoksa boş.
revision_of() {
  docker image inspect -f "{{index .Config.Labels \"$REV_LABEL\"}}" "$1" 2>/dev/null || true
}

# app konteynerinin kimliği; yoksa boş.
app_container() {
  compose ps -a -q app 2>/dev/null | head -n 1 || true
}

# healthy | starting | unhealthy | exited | ... | none
app_health() {
  local id
  id=$(app_container)
  if [[ -z $id ]]; then echo none; return; fi
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo none
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

start_app() {
  compose up -d --no-deps --force-recreate app
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

# ---------- Ana akış ----------

manual=${1:-}
if [[ -n $manual && ! $manual =~ ^[0-9a-f]{7,40}$ ]]; then
  log "HATA: geçersiz commit: $manual (7-40 karakter onaltılık sha bekleniyor)"
  exit 2
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "başka bir yayın sürüyor; bu çağrı atlandı."
  exit 0
fi

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
head=$(git_app rev-parse HEAD)
if [[ $head == "$target" && $running == "$target" && $(app_health) == healthy ]]; then
  if [[ -n $manual ]]; then log "$short zaten yayında ve sağlıklı."; fi
  exit 0
fi

if [[ -z $manual ]]; then
  if marked failed "$target"; then exit 0; fi # daha önce başarısız oldu; elle yayınlanana kadar beklenir
  if marked held "$target"; then exit 0; fi
  if [[ -n $running ]] && ! git_app diff --quiet "$running" "$target" -- deploy/compose.yml; then
    mark held "$target"
    log "BEKLETİLDİ: $short deploy/compose.yml'yi değiştiriyor; otomatik yayınlanmadı. Gözden geçirip elle yayınla: sesli-oda-yayin $short"
    exit 0
  fi
fi

prev_image=$(docker image inspect -f '{{.Id}}' "$IMAGE:current" 2>/dev/null || true)
prev_rev=""
if [[ -n $prev_image ]]; then prev_rev=$(revision_of "$prev_image"); fi

log "yayın başlıyor: $short (yayındaki: ${running:0:12})"
git_app checkout --quiet --force --detach "$target"

if [[ $(revision_of "$IMAGE:$short") == "$target" ]]; then
  log "$IMAGE:$short zaten var; yeniden kurulmadı." # geri almada hızlı dönüş
elif ! docker build --pull --quiet --label "$REV_LABEL=$target" -t "$IMAGE:$short" -f "$APP_DIR/deploy/Dockerfile" "$APP_DIR" >/dev/null; then
  mark failed "$target"
  if [[ -n $prev_rev ]]; then git_app checkout --quiet --force --detach "$prev_rev"; fi
  log "HATA: $short imajı kurulamadı; yayındaki sürüm aynen çalışıyor."
  exit 1
fi

docker tag "$IMAGE:$short" "$IMAGE:current"
start_app
if wait_healthy; then
  if ! compose up -d tunnel; then # ilk kurulumda tüneli açar; çalışıyorsa dokunmaz
    log "HATA: tunnel konteyneri başlatılamadı (uygulama $short çalışıyor)."
  fi
  rm -f "$STATE_DIR/failed" "$STATE_DIR/held"
  log "yayında: $short"
  if [[ $target != "$main_head" ]]; then
    # Geri alma: zamanlayıcı main'deki sürümü hemen geri getirmesin; main'e yeni commit gelince yayın sürer.
    mark held "$main_head"
    log "otomatik yayın main'e yeni bir commit gelene kadar durdu (main: ${main_head:0:12})."
  fi
  prune_images
  exit 0
fi

mark failed "$target"
log "HATA: $short $HEALTH_WAIT saniyede sağlıklı açılmadı (durum: $(app_health)); son günlük satırları:"
docker logs --tail 30 "$(app_container)" 2>&1 | sed 's/^/  | /' || true
if [[ -z $prev_image ]]; then
  log "HATA: geri dönülecek önceki imaj yok; site kapalı."
  exit 1
fi
log "önceki sürüme dönülüyor: ${prev_rev:0:12}"
if [[ -n $prev_rev ]]; then git_app checkout --quiet --force --detach "$prev_rev"; fi
docker tag "$prev_image" "$IMAGE:current"
start_app
if wait_healthy; then
  log "HATA: $short yayınlanamadı; önceki sürüm ${prev_rev:0:12} yeniden çalışıyor."
else
  log "HATA: $short yayınlanamadı ve önceki sürüm ${prev_rev:0:12} de sağlıklı açılmadı (durum: $(app_health))!"
fi
exit 1
