# Sesli Oda

Birden çok odalı sesli sohbet + senkronize YouTube izleme/dinleme ve oyunlar. Her oda en fazla 6 kişi;
iki oda birleşince 12 kişi.

**Canlı:** https://agalar.app

## Neler var

- Hesaplar: kullanıcı adı + şifreyle kayıt/giriş, isteğe bağlı profil resmi. Giriş tarayıcıda açık
  kalır; aynı isim ikinci kez alınamaz, aynı hesapla ikinci yerden girilince eskisi odadan düşer. Hesap
  şifresi hesap penceresinden değiştirilir.
- Odalar: giriş yapınca oda listesi açılır; adres `/oda/<oda>` (oyunlar `/oda/<oda>/oyunlar/...`, radyo
  `/oda/<oda>/radyo`). Bir hesap aynı anda tek odadadır. Ayrıntı aşağıda "Odalar ve yetkiler".
- Sesli sohbet (WebRTC, Opus); gürültü kapısı ve ses eşiği ayarı
- Herkeste aynı anda oynayan YouTube; site içi arama ve oynatma geçmişi
- Yazılı sohbet, emoji seçici
- Ses efektleri; herkes kendi efektini de yükleyebilir
- Ekran paylaşımı (Chrome/Edge'de sekme sesiyle birlikte)
- Oyunlar (üst çubuktaki sekme; oyundayken müzik ve sesli sohbet sürer): tier list (ortak tahtada
  yazılı/resimli kartlar), süre tahmini ve süre yarışı, dinozor koşusu, kelime, eşini bul, sayı bulmaca,
  hedef sayı, gizli kural, mantık tablosu, daktilo düellosu, kaydırmaca, hızlı okuma. Çok kişili oyunlar
  "Oda kur" lobisinden başlar. Skor tabloları bütün odalarda ortaktır.
- Ses kaydı: müzik dahil ya da sadece konuşmalar, MP3 veya WebM olarak iner. Kayıt sadece kaydedenin
  bilgisayarına iner, sunucuya gitmez.

## Bilgisayarında çalıştırma

Node.js 20 veya üstü gerekir. `localhost` üzerinde mikrofon HTTPS olmadan da çalışır. Birden fazla kişiyi
denemek için aynı adresi birkaç sekmede (ya da ayrı tarayıcı profillerinde) aç.

**Değişiklik denemek için test sunucusu** (Supabase'e bağlanmaz, `.env` okumaz, her şey hafızada; ayrıntı
aşağıda "Testler ve test sunucusu"):

```bash
npm install
PORT=4100 node -r ./test/preload.js server.js     # http://localhost:4100
```

**Gerçek sunucu:** `npm start` (varsayılan http://localhost:3030) `.env` dosyasını okur. `.env`'de Supabase
anahtarları varsa bu sunucu **canlı veritabanına** bağlanır: canlı sitedeki hesaplar, odalar ve kayıtlar
üzerinde çalışır. Yalnız yayındaki kodu çalıştırmak içindir; burada deneme hesabı, deneme odası ya da deneme
verisi açılmaz, bir daldaki değişiklik bununla denenmez. Çoklu oda SQL'leri canlıya uygulanmadan önce yeni kod
bu sunucuyla açılmaz (log'da `SUNUCU AÇILMIYOR`; bkz. "Canlıya alma").

## Proje yapısı

Derleme adımı yok; `public/` içindeki dosyalar olduğu gibi sunulur.

| Dosya | Ne işe yarar |
| --- | --- |
| `server.js` | Express + Socket.IO: odaların canlı durumu, sinyalleşme, sohbet, YouTube araması, oyunlar |
| `rooms.js` | Oda kayıtları, oda istekleri, şifreli odaların üyeleri, tema listesi (`THEMES`) |
| `merge.js` | Oda birleştirme (yalnız hafızada) |
| `games/` | Daktilo, hedef sayı, gizli kural, mantık tablosu oyunlarının sunucu tarafı |
| `store.js` | Supabase'e kalıcı kayıt (geçmiş, efektler, tier listler, skor tabloları) |
| `accounts.js` | Hesaplar, oturumlar, profil resimleri, site yöneticileri (`ADMINS`) |
| `clientip.js` | Ziyaretçinin gerçek adresi (deneme sınırları için; `CLIENT_IP_HEADER`) |
| `deploy/` | Kendi sunucuda yayın: `Dockerfile`, `compose.yml`, `yayin.sh`, systemd birimleri (bkz. "Katkı ve yayın") |
| `db/` | Canlıya geçişte elle çalıştırılan SQL dosyaları |
| `public/index.html` | Arayüzün işaretlemesi; gömülü ikon seti (`<svg id="ui-icons">`) |
| `public/css/base.css`, `shell.css`, `games.css` | Ortak bileşenler, ekran çerçeveleri, oyun tahtaları (yalnız değişken kullanır) |
| `public/themes/<tema>.css` | Tema: renk, yazı tipi, köşe, gölge değişkenleri |
| `public/theme.js` | Tema yükleyici, tema listesi ve önizleme renkleri |
| `public/lobby.js` | Giriş sonrası oda listesi, oda istekleri, şifre pencereleri, Üyeler sayfası |
| `public/app.js` | Oda içi istemci: ses, YouTube, sohbet, kayıt, oyunlar |
| `public/icons/ui/` | Arayüz ikonları (Lucide, lisansı yanında) |
| `public/vendor/fonts/` | Gömülü yazı tipleri (Geist, Nunito; lisansları yanında) |
| `public/sfx.js`, `public/sfx/` | Ses efektleri |
| `public/gate-worklet.js` | Mikrofon gürültü kapısı (AudioWorklet) |
| `public/rec-worklet.js`, `mp3-worker.js` | Kayıt ve MP3'e çevirme |
| `public/vendor/lame.min.js` | MP3 kodlayıcı (lamejs 1.2.1, LGPL); elle düzenlemeyin |

## Odalar ve yetkiler

Üç rol var:

- **Site yöneticisi** (`accounts.js` `ADMINS`, şu an `osyalcin`): oda açar (sahibini seçebilir), oda
  isteklerini onaylar ya da reddeder, odayı kapatır (`genel` kapatılamaz), her odada sahibin yapabildiği
  her şeyi yapar, odanın adını ve sahibini değiştirir. Üyeler sayfasını (`/uyeler`) ve 🫏 düğmesini yalnız
  yönetici görür.
- **Oda sahibi**: kendi odasının temasını ve şifresini değiştirir, odasını başka bir odayla birleştirir ya
  da birleşmeyi ayırır.
- **Üye**: şifresiz odaya doğrudan girer; şifreli odaya şifreyi bir kez doğru yazınca üye olur ve bir daha
  sorulmaz.

**Oda isteği:** yönetici olmayan kişi listedeki "Oda iste" ile ad, isteğe bağlı şifre, tema ve not gönderir
(aynı anda tek bekleyen istek). Yönetici "İstekler"den onaylayınca oda açılır ve isteyen sahibi olur; sonuç
isteyene anında gelir.

**Şifreler:** oda şifresi 4-200 karakter; yalnız özeti saklanır. Şifre değişince ya da kaldırılınca eski
üyelikler silinir, herkes yeni şifreyi yeniden yazar.

**Birleştirme:** oda sahibi (ya da yönetici) oda ayarlarından başka bir odayla birleşme ister; karşı odanın
sahibi 60 saniye içinde kabul ederse misafir odadakiler ev sahibi odaya taşınır, sohbet, müzik, oyun lobileri
ve tema (ev sahibinin teması) ortak olur. Her odadan en fazla 6, toplam 12 kişi. Yönetici isterse hemen
birleşir. Reddedilen ya da süresi dolan istekten sonra aynı yöne 60 saniye yeni istek yok; bir hesap
dakikada en çok 3 istek gönderir. "Odaları ayır" ile herkes kendi odasına, kendi temasıyla döner.
Birleşme yalnız hafızadadır: sunucu yeniden başlarsa odalar ayrı açılır.

## Temalar

Görünümün bütün renkleri, yazı tipleri, köşeleri ve gölgeleri değişkendir; değişken sözleşmesi
`public/css/base.css`'in başında yazılıdır. Kurallarda sabit renk yazılmaz. Oda sahibi temayı oda
ayarlarından seçip "Uygula"ya basar; odadaki herkeste sayfa yenilenmeden değişir. Oda listesi ve giriş ekranı
her zaman varsayılan temadadır (Gece Odası). Temalar: Gece Odası (`gece`, koyu, varsayılan), Aydınlık Oda
(`aydinlik`, açık) ve Piksel Oda (`piksel`, retro oyun: kendi piksel yazı tipleri ve piksel ikon seti).

Yeni tema eklemek (örnek kimlik `yeni`):

1. `public/themes/yeni.css`: sözleşmedeki bütün değişkenleri tanımlar (`public/themes/gece.css`'i kopyala).
   Metin kontrastı en az 4,5:1 olmalı. Kendi yazı tipi varsa `@font-face` bu dosyada (yalnız tema seçilince
   iner), dosyası lisansıyla `public/vendor/fonts/<ad>/` altında.
2. İkon seti: `public/icons/ui/<set>.svg`, `lucide.svg` ile aynı `i-…` adlarını taşır (lisansı yanına,
   `LICENSE-<set kaynağı>`). Üretici: `test/tools/icons.js`. Aynı seti kullanacaksa bu adım yok.
3. `public/theme.js`: `LIST`'e `'yeni'`, `NAMES`'e görünen ad, `ICON_SETS`'e ikon seti, `PREVIEW`'e oda
   kartı önizleme renkleri (bg, surface, text, accent).
4. `rooms.js`: `THEMES` dizisine `'yeni'` (sunucu tanımadığı temayı kabul etmez).

## Testler ve test sunucusu

```bash
npm test           # node --test --test-concurrency=1 test/  (test/*.test.js, sırayla)
```

Testler kendi sunucularını hafızada, Supabase'siz açar.

Arayüzü elle denemek için **test sunucusu** (Supabase'e bağlanmaz, `.env` okumaz, her şey hafızada):

```bash
PORT=4100 node -r ./test/preload.js server.js
```

Tarayıcıda giriş yapmadan `localStorage.token = 'test:Ali'` yazıp sayfayı yenilemek o adla oturum açar;
`test:osyalcin` site yöneticisidir. Hesap şifresi değiştirme gibi kayıtlı hesap isteyen işler için
`POST /auth/register` ile hesap açılır. Test sunucusunda denemelik ikinci bir tema ("Deneme (test)") da
vardır; canlıda yoktur. **Bir dalda sunucuyu önyüklemesiz (`npm start` ya da `node server.js`) çalıştırma:**
`.env` varsa canlı veritabanına bağlanır.

## Canlıya alma (çoklu oda geçişi)

Çoklu oda ilk kez canlıya alınırken sıra tam olarak şudur (SQL'ler Supabase SQL düzenleyicisinde elle
çalıştırılır, dosyaların başındaki notları oku):

1. `db/2026-11-22-rooms.sql` uygulanır (oda, istek ve üyelik tabloları; eski sunucu bunları kullanmaz, önceden
   yapılabilir).
2. Eski sunucu durdurulur.
3. `db/2026-11-22-golive.sql` uygulanır (`genel` odası ve ortak skor tabloları).
4. Yeni sunucu açılır.

Supabase ayarlıyken 1. ya da 3. adım eksikse yeni sunucu açılmayı reddeder: log'da `SUNUCU AÇILMIYOR` satırı
çıkar ve süreç kapanır (kayıtlar sessizce kaybolmasın diye). Yani SQL'ler uygulanmadan yeni kod canlıda
çalışmaz.

## Katkı ve yayın

`main` dalına yapılan her push birkaç dakika içinde canlı sitede olur. Push'tan önce:

1. Değişikliği bilgisayarında test sunucusuyla (`PORT=<port> node -r ./test/preload.js server.js`) dene ve
   `npm test` çalıştır; tarayıcı konsolunda hata olmasın. `npm start` canlı veritabanına bağlandığı için
   deneme için kullanılmaz.
2. Büyük ya da riskli bir değişiklikse ayrı bir dalda çalış ve pull request aç.
3. Commit mesajlarını Türkçe ve ne yaptığını anlatacak şekilde yaz.

**Geçiş dönemi:** site Render'dan kendi sunucumuza taşınıyor. Geçiş onaylanana kadar Render servisi ve
`render.yaml` yerinde kalır (Render'da `CLIENT_IP_HEADER` ayarlı olmadığı için davranış orada değişmez); geçiş bir
hafta sorunsuz sürünce Render servisi silinir, `render.yaml` kaldırılır ve bu not güncellenir.
O zamana kadar Render'daki yayının durumu ve kayıtları Render panelindeki **Events** ve **Logs** sekmelerindedir.

### Kendi sunucuda yayın

Uygulama sunucuda bir Docker konteynerinde çalışır ve dışarıya port açmaz; ziyaretçiler Cloudflare Tunnel
üzerinden gelir (`tunnel` konteyneri Cloudflare'e kendisi bağlanır, yalnız `app:3030`'a iletir).

Sunucudaki yerleşim:

| Yol | Ne |
| --- | --- |
| `/srv/sesli-oda/app/` | Bu deponun git kopyası (`sesli-oda` kullanıcısına ait; yayın betiği belli bir commit'e geçirir) |
| `/srv/sesli-oda/.env` | Sırlar (root, `600`): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, `YT_API_KEY`, `CLIENT_IP_HEADER=cf-connecting-ip`, `TUNNEL_TOKEN`. Git'e girmez. |
| `/srv/sesli-oda/state/` | Yayın betiğinin kayıtları (başarısız ya da bekletilen commit) |
| `/usr/local/sbin/sesli-oda-yayin` | `deploy/yayin.sh`'nin root'a ait kopyası |
| `/etc/systemd/system/sesli-oda-yayin.{service,timer}` | `deploy/` altındakilerin kopyası; dakikada bir yayın betiğini çalıştırır |

- `deploy/compose.yml`: compose projesi `sesli-oda`; `app` (salt-okunur dosya sistemi, kök olmayan kullanıcı,
  yetenek yok, 512 MB) ve `tunnel` (`cloudflare/cloudflared`). Kendi ağı `sesli-oda` (`172.31.240.0/28`), port
  yayınlanmaz. Sırlar compose'a `--env-file /srv/sesli-oda/.env` ile verilir ve her konteyner yalnız kendi
  değişkenlerini alır (`app` tünel anahtarını, `tunnel` Supabase anahtarını görmez). Günlükler journald'ye
  gider: `journalctl -t sesli-oda-sesli-oda-app-1 -f` (tünel için `...-tunnel-1`), yayın betiği için
  `journalctl -u sesli-oda-yayin`.
- `deploy/Dockerfile`: `node:22-alpine`, yalnız `package*.json`, kökteki `*.js`, `games/` ve `public/` kopyalanır.
  Köke yeni bir klasör eklenirse Dockerfile'a ve `.dockerignore`'a da eklenmeli.
- **Yayın (`sesli-oda-yayin`, dakikada bir):** `origin/main`'i çeker; yeni commit varsa imajı
  `sesli-oda-app:<kısa sha>` olarak kurar, `current` etiketini ona verir, `app`'i yeniden başlatır ve 60 saniye
  içinde sağlık denetiminden (`GET /theme-list`) geçmesini bekler. Geçemezse (ör. log'da `SUNUCU AÇILMIYOR`)
  önceki imaja döner, hata koduyla çıkar ve o commit'i bir daha kendiliğinden denemez. Son 3 imaj tutulur.
  `deploy/compose.yml`'yi değiştiren bir commit otomatik yayınlanmaz (compose dosyası konteynere sunucuda yetki
  verebilir): log'da `BEKLETİLDİ` yazar, gözden geçirilip elle yayınlanır. `deploy/yayin.sh` ve systemd
  birimlerindeki değişiklikler de kendiliğinden devreye girmez; sunucuya elle kopyalanır.
- **Elle yayın ve geri alma:** `ssh otomasyon sudo sesli-oda-yayin <sha>` o commit'i yayınlar (main'in
  geçmişinde olmalı; imajı hâlâ duruyorsa yeniden kurulmaz). Eski bir commit'e dönülünce otomatik yayın main'e
  yeni bir commit gelene kadar durur. Bekletilmiş ya da başarısız olmuş bir commit de aynı komutla yayınlanır.
- Compose'u elle çalıştırırken `--env-file` unutulmamalı (unutulursa compose zorunlu değişken hatasıyla durur):
  `sudo docker compose --env-file /srv/sesli-oda/.env -f /srv/sesli-oda/app/deploy/compose.yml ps`.

**Gerçek ziyaretçi adresi (`CLIENT_IP_HEADER`):** giriş, şifre değiştirme, oda şifresi ve kayıt olma sınırları
ziyaretçi adresine göre sayılır. Tünel arkasında `CLIENT_IP_HEADER=cf-connecting-ip` ayarlanır: adres bu
başlıktan alınır; başlık yoksa ya da geçerli tek bir adres değilse bağlantının kendi adresi kullanılır ve
`X-Forwarded-For`'a bakılmaz. Bu ayar yalnız uygulamaya Cloudflare dışından ulaşılamıyorsa güvenlidir (başlığı
istemci de yazabilir). Ayarlı değilse eski kural geçerlidir (Render'ın vekili: `X-Forwarded-For`'un son değeri).

## Ortam değişkenleri

Kendi sunucuda `/srv/sesli-oda/.env`'de (bkz. "Kendi sunucuda yayın"), Render'da **Environment** bölümünde,
bilgisayarda `.env`'de durur; anahtarlar koda yazılmaz. Sunucudaki konteynerde `SUPABASE_URL`,
`SUPABASE_SECRET_KEY`, `CLIENT_IP_HEADER` ve `TUNNEL_TOKEN` zorunludur, gerisi isteğe bağlı.

| Değişken | Ne işe yarar |
| --- | --- |
| `YT_API_KEY` | Site içi YouTube araması (YouTube Data API v3, ücretsiz, günlük ~100 arama). Yoksa arama kapalıdır, link yapıştırma çalışır. Aynı arama 1 saat önbellekte tutulur. |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Cloudflare TURN: bazı mobil ağlarda doğrudan bağlantı kurulamaz ("Bağlanamadı"); sunucu bu anahtarlarla geçici TURN bilgisi üretir. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Bazı mobil ağlarda doğrudan bağlantı kurulamaz ("Bağlanamadı"); o zaman bir TURN sunucusu gerekir. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Hesaplar, önceden çalanlar, özel efektler ve tier listler Supabase'de kalıcı tutulur (`accounts`, `sessions`, `room_state`, `rooms`, `room_requests`, `room_members` tabloları ve özel `media` bölmesi). Şifrelerin sadece scrypt özeti, oturum anahtarlarının sadece SHA-256 özeti saklanır. Yoksa sadece hafızada durur, sunucu uyuyunca silinir. Bilgisayarda `.env` dosyasına yazılır (git'e girmez). Bilgisayarda `npm start` ile açılan sunucu canlı siteyle aynı kayıtları kullanır (test sunucusu kullanmaz): ikisi aynı anda açıkken aynı odada değişiklik yapılırsa son yazan kazanır, ve her sunucu kayıtları sadece açılırken okur. |
| `CLIENT_IP_HEADER` | Ziyaretçi adresinin okunacağı başlık; tünel arkasında `cf-connecting-ip`. Ayarlı değilse `X-Forwarded-For`'un son değeri (Render). Yalnız uygulamaya o başlığı yazan vekil dışında ulaşılamıyorsa ayarlanır. |
| `TUNNEL_TOKEN` | Yalnız sunucuda, `tunnel` konteyneri için (Cloudflare Tunnel anahtarı); uygulama konteynerine verilmez. |
| `PORT` | Sunucu portu (varsayılan 3030; Render kendisi verir, konteynerde 3030). |

## İnternet kullanımı

- Ses: Opus 32 kbps, sessizken neredeyse 0 (DTX). 5 kişiyle konuşurken ~10-20 MB/saat.
- Müzik/video: Herkes YouTube'dan kendi cihazında oynatır; uygulama sadece "oynat / durdur / şu saniye"
  komutlarını iletir. Asıl veri tüketimi YouTube videosunun kendisidir.

## Lisanslar

Ses efektlerinin kaynakları ve lisansları `public/sfx/KAYNAKLAR.txt` içinde; bu dosyayı silmeyin. Dört efekt
(Ding, Hüzün, Tada, Bum) CC BY 3.0 lisanslı ve atıf ister; uygulamada şu an atıf linki yok.
