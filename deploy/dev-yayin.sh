#!/usr/bin/env bash
# dev.agalar.app yayını (sunucuda). Kurulumda root'a ait bir kopya olarak /usr/local/sbin/sesli-oda-dev-yayin'e
# konur; depodaki değişiklikler kendiliğinden devreye girmez.
#
#   sesli-oda-dev-yayin         origin/dev'deki son commit'in public/ dizinini yayınlar (zamanlayıcı dakikada bir).
#                               dev dalı yoksa ya da commit zaten yayındaysa sessizce çıkar.
#   sesli-oda-dev-yayin <sha>   O commit'in public/'ini yayınlar (dev'in geçmişinde olmalı).
#
# Dev dalından hiçbir kod sunucuda çalışmaz: yalnız public/ dosyaları (statik) dışarı çıkarılır ve `dev` Caddy
# konteyneri onları tarayıcılara gönderir. Ortak git kopyasında (/srv/sesli-oda/app) yalnız fetch yapılır;
# çalışma ağacı canlı yayının (yayin.sh) malıdır, burada hiçbir zaman checkout yapılmaz. Konteyner yeniden
# başlatılmaz: `current` sembolik bağı yeni sürüme çevrilir, Caddy yolu her istekte çözer.
#
# Güvenlik: commit'in public/ ağacı önce git'te denetlenir (yalnız düz dosya ve dizin; sembolik bağ ve alt modül
# reddedilir; yol public/ dışına çıkamaz; dosya sayısı ve toplam boyut sınırlı), sonra yalnız o ağacın arşivi
# root'a ait yeni bir dizine açılır (GNU tar: sahiplik ve izinler arşivden alınmaz, '..' içeren üye atlanır) ve
# açılan dizinde düz dosya ve dizinden başka bir şey olmadığı yeniden denetlenir.
set -euo pipefail

BASE_DIR=${BASE_DIR:-/srv/sesli-oda}
APP_DIR=${APP_DIR:-$BASE_DIR/app}                 # ortak git kopyası ($GIT_USER'a ait); yalnız fetch
WWW_DIR=${WWW_DIR:-$BASE_DIR/dev/www}             # konteynere salt-okunur bağlanır (/srv/dev/www)
RELEASES=$WWW_DIR/releases                        # releases/<kısa sha>/public/...
STATE_DIR=${STATE_DIR:-$BASE_DIR/state}
REV_FILE=$STATE_DIR/dev-rev
LOCK_FILE=${LOCK_FILE:-/run/sesli-oda-dev-yayin/lock} # dizin root 700 (birimde RuntimeDirectory)
GIT_USER=${GIT_USER-sesli-oda}                    # boşsa git çalıştıranın kendisiyle çalışır (yalnız deneme)
BRANCH=dev
MAX_FILES=${MAX_FILES:-5000}
MAX_BYTES=${MAX_BYTES:-$(( 200 * 1024 * 1024 ))}  # 200 MB
KEEP=3                                            # tutulan son sürüm sayısı

log() { echo "sesli-oda-dev-yayin: $*"; }

git_app() {
  if [[ -n $GIT_USER ]]; then
    setpriv --reuid="$GIT_USER" --regid="$GIT_USER" --init-groups --reset-env -- git -C "$APP_DIR" "$@"
  else
    git -C "$APP_DIR" "$@"
  fi
}

# Commit'in public/ ağacını denetler: yalnız düz dosya (100644/100755) ve dizin; sembolik bağ (120000) ve alt
# modül (160000) yok; her yol public/ altında ve '..' bileşeni yok; sayı ve boyut sınırda. NUL ayraçlı okunur
# (adında satır sonu olan dosya da doğru okunur).
check_tree() {
  local meta path mode type size count=0 total=0
  while IFS= read -r -d '' rec; do
    meta=${rec%%$'\t'*}
    path=${rec#*$'\t'}
    read -r mode type _ size <<< "$meta"
    case $mode in
      100644|100755) ;;
      120000) log "REDDEDİLDİ: sembolik bağ: $path"; return 1 ;;
      160000) log "REDDEDİLDİ: alt modül: $path"; return 1 ;;
      *) log "REDDEDİLDİ: desteklenmeyen dosya türü ($mode $type): $path"; return 1 ;;
    esac
    case /$path/ in
      */../*|*/./*|//*) log "REDDEDİLDİ: geçersiz yol: $path"; return 1 ;;
    esac
    if [[ $path != public/* ]]; then log "REDDEDİLDİ: public/ dışında: $path"; return 1; fi
    count=$(( count + 1 ))
    total=$(( total + size ))
  done < <(git_app ls-tree -r -z -l "$target" -- public/)
  if (( count == 0 )); then log "REDDEDİLDİ: $short commit'inde public/ yok ya da boş."; return 1; fi
  if (( count > MAX_FILES )); then log "REDDEDİLDİ: $count dosya (sınır $MAX_FILES)."; return 1; fi
  if (( total > MAX_BYTES )); then log "REDDEDİLDİ: toplam $total bayt (sınır $MAX_BYTES)."; return 1; fi
}

# Arşivin üye adlarını da denetler (git ağacıyla aynı olmalı; savunma derinliği).
check_listing() {
  local name
  while IFS= read -r name; do
    case /$name in
      */../*|*/..|//*) log "REDDEDİLDİ: arşivde geçersiz yol: $name"; return 1 ;;
    esac
    if [[ $name != public && $name != public/* ]]; then log "REDDEDİLDİ: arşivde public/ dışında: $name"; return 1; fi
  done < <(tar -tf "$1")
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
  if [[ -n $manual ]]; then log "HATA: başka bir dev yayını sürüyor; biraz sonra tekrar dene."; exit 1; fi
  exit 0
fi

# dev dalı yoksa sessiz çıkış (ls-remote: bulunamazsa 2, ağ hatasında başka kod).
rc=0
git_app ls-remote --exit-code --heads origin "refs/heads/$BRANCH" >/dev/null || rc=$?
if (( rc == 2 )); then
  if [[ -n $manual ]]; then log "HATA: origin'de $BRANCH dalı yok."; exit 2; fi
  exit 0
elif (( rc != 0 )); then
  log "HATA: origin'e ulaşılamadı (git ls-remote $rc)."
  exit 1
fi

git_app fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
dev_head=$(git_app rev-parse "refs/remotes/origin/$BRANCH^{commit}")
if [[ -n $manual ]]; then
  if ! target=$(git_app rev-parse --verify --quiet "$manual^{commit}"); then
    log "HATA: commit bulunamadı: $manual"
    exit 2
  fi
  if ! git_app merge-base --is-ancestor "$target" "refs/remotes/origin/$BRANCH"; then
    log "HATA: $manual $BRANCH dalının geçmişinde değil; yayınlanmadı."
    exit 2
  fi
else
  target=$dev_head
fi
short=${target:0:12}
release=$RELEASES/$short

current_link=$(readlink "$WWW_DIR/current" 2>/dev/null || true)
if [[ -f $REV_FILE && $(cat "$REV_FILE") == "$target" && $current_link == "releases/$short" && -d $release/public ]]; then
  if [[ -n $manual ]]; then log "$short zaten dev'de yayında."; fi
  exit 0
fi
if [[ -z $manual ]]; then
  for f in dev-failed dev-pinned; do
    # dev-failed: bu commit daha önce reddedildi; dev-pinned: elle eski bir sürüme dönüldü. İkisinde de dev'e
    # yeni bir commit gelene ya da elle çağrılana kadar beklenir.
    if [[ -f $STATE_DIR/$f && $(cat "$STATE_DIR/$f") == "$target" ]]; then exit 0; fi
  done
fi

log "dev yayını başlıyor: $short"
fail() { echo "$target" > "$STATE_DIR/dev-failed"; log "HATA: $short dev'e yayınlanmadı; dev'deki sürüm aynen sunuluyor."; exit 1; }
mkdir -p "$STATE_DIR"
install -d -m 755 "$WWW_DIR" "$RELEASES"

if [[ ! -d $release/public ]]; then
  check_tree || fail
  work=$(mktemp -d "$RELEASES/.yeni-$short.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  if ! git_app archive --format=tar "$target" public > "$work/public.tar"; then log "HATA: git archive başarısız."; fail; fi
  check_listing "$work/public.tar" || fail
  mkdir -m 755 "$work/out"
  # GNU tar 1.35: root olarak bile sahiplik (--no-same-owner) ve izinler (--no-same-permissions, umask 022)
  # arşivden alınmaz; mutlak yol ve '..' içeren üyeler zaten varsayılan olarak reddedilir.
  if ! (umask 022 && tar -x -f "$work/public.tar" -C "$work/out" --no-same-owner --no-same-permissions); then
    log "HATA: arşiv açılamadı."
    fail
  fi
  odd=$(find "$work/out" ! -type f ! -type d | head -n 5)
  if [[ -n $odd ]]; then log "REDDEDİLDİ: düz dosya/dizin olmayan girdi: $odd"; fail; fi
  if [[ ! -d $work/out/public ]]; then log "HATA: arşivde public/ yok."; fail; fi
  chmod -R a+rX,go-w "$work/out"
  mv "$work/out" "$release"
  rm -rf "$work"
  trap - EXIT
fi

# Atomik geçiş: yeni bağ yanında kurulur, rename ile eskisinin yerine geçer (Caddy hiçbir an yarım dizin görmez).
ln -sfn "releases/$short" "$WWW_DIR/.current.yeni"
mv -T "$WWW_DIR/.current.yeni" "$WWW_DIR/current"
echo "$target" > "$REV_FILE.yeni" && mv -f "$REV_FILE.yeni" "$REV_FILE"
rm -f "$STATE_DIR/dev-failed" "$STATE_DIR/dev-pinned"
log "dev'de yayında: $short"
if [[ $target != "$dev_head" ]]; then
  echo "$dev_head" > "$STATE_DIR/dev-pinned"
  log "otomatik dev yayını dev dalına yeni bir commit gelene kadar durdu (dev: ${dev_head:0:12})."
fi

# Son $KEEP sürüm kalır (yayındaki her zaman kalır).
n=0
for d in $(ls -1t "$RELEASES"); do
  if [[ $d == .* ]]; then continue; fi
  n=$(( n + 1 ))
  if (( n > KEEP )) && [[ $d != "$short" ]]; then rm -rf "${RELEASES:?}/$d"; log "eski sürüm silindi: $d"; fi
done
