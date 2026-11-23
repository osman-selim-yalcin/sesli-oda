#!/usr/bin/env bash
# Sesli Oda konteyner ağının sunucu güvenlik duvarı kuralları (IPv4, iptables). Kurulumda root'a ait bir kopya
# olarak /usr/local/sbin/sesli-oda-ag'a konur; sesli-oda-ag.service docker her açıldığında çalıştırır.
#
#   sesli-oda-ag          kuralları ekler (eksik varsa hepsini doğru sırayla yeniden yazar; tekrar çalıştırmak güvenli)
#   sesli-oda-ag kaldir   yalnız bu betiğin kurallarını siler
#
# Kaynak 172.31.240.0/28 (compose ağı sesli-oda) için:
#   INPUT:       konteynerden sunucunun kendisine giden her şey düşer (host servisleri, host'un adresleri).
#                Docker'ın gömülü DNS'i (127.0.0.11) konteynerin kendi ağ ad alanında dinler ve dış sorguları
#                dockerd host ad alanından kendi yapar; bu yüzden konteyner alt ağından host INPUT'una paket
#                gelmesi gerekmez.
#   DOCKER-USER: önce alt ağ içi (app <-> tunnel) RETURN, sonra özel/iç ağlara (10/8, 172.16/12, 192.168/16,
#                100.64/10 Tailscale, 169.254/16 metadata) DROP. Gerisi (internet) olduğu gibi geçer.
# IPv6 kuralı yok: compose ağında IPv6 açık değil. Docker'ın kurulum (build) ağı bu kuralların dışındadır.
# Başka birimlerin DOCKER-USER kurallarına (ör. "-o tailscale0 -j DROP") dokunulmaz; bizimkiler en üste eklenir.
set -euo pipefail

SUBNET=172.31.240.0/28
TAG=sesli-oda-ag # yorum etiketi: kaldırırken yalnız bizim kurallar bulunur
IPT=(iptables -w)

# Kurallar sırasıyla: zincir|kural
rules() {
  local m=(-m comment --comment "$TAG")
  printf '%s\n' \
    "INPUT|-s $SUBNET ${m[*]} -j DROP" \
    "DOCKER-USER|-s $SUBNET -d $SUBNET ${m[*]} -j RETURN" \
    "DOCKER-USER|-s $SUBNET -d 10.0.0.0/8 ${m[*]} -j DROP" \
    "DOCKER-USER|-s $SUBNET -d 172.16.0.0/12 ${m[*]} -j DROP" \
    "DOCKER-USER|-s $SUBNET -d 192.168.0.0/16 ${m[*]} -j DROP" \
    "DOCKER-USER|-s $SUBNET -d 100.64.0.0/10 ${m[*]} -j DROP" \
    "DOCKER-USER|-s $SUBNET -d 169.254.0.0/16 ${m[*]} -j DROP"
}

# Kural metninde boşluklu değer yok (yorum etiketi tek kelime), kelimelere bölmek güvenli.
has() { # has <zincir> <kural>
  # shellcheck disable=SC2086
  "${IPT[@]}" -C "$1" $2 2>/dev/null
}

remove_all() {
  local chain rule
  while IFS='|' read -r chain rule; do
    # shellcheck disable=SC2086
    while has "$chain" "$rule"; do "${IPT[@]}" -D "$chain" $rule; done
  done < <(rules)
}

all_present() {
  local chain rule
  while IFS='|' read -r chain rule; do
    has "$chain" "$rule" || return 1
  done < <(rules)
}

install() {
  if ! "${IPT[@]}" -n -L DOCKER-USER >/dev/null 2>&1; then
    echo "sesli-oda-ag: HATA: DOCKER-USER zinciri yok (docker açık mı?)." >&2
    exit 1
  fi
  if all_present; then
    echo "sesli-oda-ag: kurallar zaten yerinde."
    return
  fi
  # Sıra önemli (RETURN DROP'lardan önce): eksik varsa hepsi silinip baştan, en üste sırayla eklenir.
  remove_all
  local chain rule n_input=0 n_user=0 pos
  while IFS='|' read -r chain rule; do
    if [[ $chain == INPUT ]]; then n_input=$(( n_input + 1 )); pos=$n_input; else n_user=$(( n_user + 1 )); pos=$n_user; fi
    # shellcheck disable=SC2086
    "${IPT[@]}" -I "$chain" "$pos" $rule
  done < <(rules)
  echo "sesli-oda-ag: kurallar eklendi ($SUBNET)."
}

case ${1:-kur} in
  kur) install ;;
  kaldir) remove_all; echo "sesli-oda-ag: kurallar kaldırıldı." ;;
  *) echo "kullanım: sesli-oda-ag [kur|kaldir]" >&2; exit 2 ;;
esac
