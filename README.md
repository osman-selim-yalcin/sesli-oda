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

`main` dalına yapılan her push, Render'da otomatik olarak yayına alınır. Yani **`main`'e giden her şey
birkaç dakika içinde canlı sitede olur.** Push'tan önce:

1. Değişikliği bilgisayarında test sunucusuyla (`PORT=<port> node -r ./test/preload.js server.js`) dene ve
   `npm test` çalıştır; tarayıcı konsolunda hata olmasın. `npm start` canlı veritabanına bağlandığı için
   deneme için kullanılmaz.
2. Büyük ya da riskli bir değişiklikse ayrı bir dalda çalış ve pull request aç.
3. Commit mesajlarını Türkçe ve ne yaptığını anlatacak şekilde yaz.

Yayının durumu ve kayıtları Render panelindeki **Events** ve **Logs** sekmelerindedir. Ücretsiz planda
sunucu bir süre kullanılmayınca uyur; ilk açılış 30-60 saniye sürebilir.

## Ortam değişkenleri

Hepsi isteğe bağlı. Render'da **Environment** bölümünden eklenir; anahtarlar koda yazılmaz.

| Değişken | Ne işe yarar |
| --- | --- |
| `YT_API_KEY` | Site içi YouTube araması (YouTube Data API v3, ücretsiz, günlük ~100 arama). Yoksa arama kapalıdır, link yapıştırma çalışır. Aynı arama 1 saat önbellekte tutulur. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Bazı mobil ağlarda doğrudan bağlantı kurulamaz ("Bağlanamadı"); o zaman bir TURN sunucusu gerekir. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Hesaplar, önceden çalanlar, özel efektler ve tier listler Supabase'de kalıcı tutulur (`accounts`, `sessions`, `room_state`, `rooms`, `room_requests`, `room_members` tabloları ve özel `media` bölmesi). Şifrelerin sadece scrypt özeti, oturum anahtarlarının sadece SHA-256 özeti saklanır. Yoksa sadece hafızada durur, sunucu uyuyunca silinir. Bilgisayarda `.env` dosyasına yazılır (git'e girmez). Bilgisayarda `npm start` ile açılan sunucu canlı siteyle aynı kayıtları kullanır (test sunucusu kullanmaz): ikisi aynı anda açıkken aynı odada değişiklik yapılırsa son yazan kazanır, ve her sunucu kayıtları sadece açılırken okur. |
| `PORT` | Sunucu portu (varsayılan 3030; Render kendisi verir). |

## İnternet kullanımı

- Ses: Opus 32 kbps, sessizken neredeyse 0 (DTX). 5 kişiyle konuşurken ~10-20 MB/saat.
- Müzik/video: Herkes YouTube'dan kendi cihazında oynatır; uygulama sadece "oynat / durdur / şu saniye"
  komutlarını iletir. Asıl veri tüketimi YouTube videosunun kendisidir.

## Lisanslar

Ses efektlerinin kaynakları ve lisansları `public/sfx/KAYNAKLAR.txt` içinde; bu dosyayı silmeyin. Dört efekt
(Ding, Hüzün, Tada, Bum) CC BY 3.0 lisanslı ve atıf ister; uygulamada şu an atıf linki yok.
