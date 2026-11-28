# Sesli Oda

[English](README.en.md)

Birden çok odalı sesli sohbet + senkronize YouTube izleme/dinleme ve oyunlar. Her oda en fazla 10 kişi;
iki oda birleşince 20 kişi (her odadan 10). Site yöneticisi bu sayıya girmez, dolu odaya da girer.

**Canlı:** https://agalar.app

## Neler var

- Hesaplar: kullanıcı adı + şifreyle kayıt/giriş, isteğe bağlı profil resmi. Giriş tarayıcıda açık
  kalır; aynı isim ikinci kez alınamaz, aynı hesapla ikinci yerden girilince eskisi odadan düşer. Hesap
  şifresi hesap penceresinden değiştirilir.
- Odalar: giriş yapınca oda listesi açılır; adres `/oda/<oda>` (oyunlar `/oda/<oda>/oyunlar/...`, radyo
  `/oda/<oda>/radyo`). Bir hesap aynı anda tek odadadır. Ayrıntı aşağıda "Odalar ve yetkiler".
- Sesli sohbet (WebRTC, Opus); gürültü kapısı ve ses eşiği ayarı. Mikrofon açılamazsa (izin kapalı, cihaz yok,
  başka bir uygulama kullanıyor) not nedenini söyler; "Tekrar dene" ile ya da cihaz geri gelince mikrofon odadan
  çıkmadan yeniden bağlanır.
- Herkeste aynı anda oynayan YouTube; site içi arama ve oynatma geçmişi
- Yazılı sohbet, emoji seçici
- Ses efektleri; herkes kendi efektini de yükleyebilir
- Ekran paylaşımı (Chrome/Edge'de sekme sesiyle birlikte)
- Oyunlar (üst çubuktaki sekme; oyundayken müzik ve sesli sohbet sürer): tier list (ortak tahtada
  yazılı/resimli kartlar), süre tahmini ve süre yarışı, dinozor koşusu, kelime, eşini bul, sayı bulmaca,
  hedef sayı, gizli kural, mantık tablosu, İttirmeli XOX, Dört Taş, Beş Harf (günlük kelime), daktilo düellosu, kaydırmaca, hızlı okuma. Çok kişili oyunlar
  "Oda kur" lobisinden başlar (lobide odadaki herkes ve bot; kelime 6, dinozor 7, sayı bulmaca, İttirmeli XOX ve Dört Taş 2 kişiyle
  sınırlı). Skor tabloları bütün odalarda ortaktır.
- **Kutu Oyunları** bölümünde Yörünge Kuşatması, Takımada ve Yedi Kapı bulunur. Yörünge’de her filoda
  birer Yankı, Dalış ve Çekici vardır. Bunlar Hive’ın Mosquito, Ladybug ve Pillbug genişletmelerinin
  uzay temalı karşılıklarıdır. [Hive kural kitapçığı](https://hivegame.com/download/rules.pdf)
- Takımada, 24 arazili uzun bir adada iskele, fener ve rota kurma oyunudur: dört mal (kereste, taş, balık, tuz),
  tek gelgit zarı, her sıra sonunda kendiliğinden sürüklenen fırtına, bankayla 3:1 takas; ilk 8 puan kazanır.
  Yedi Kapı, özgün zindan karşılaşmaları, ekipman, iksir ve yardım teklifleriyle 10. seviyeye oynanır.
  İkisi de 2–4 oyunculudur. Dev’in bağlı olduğu sunucu oyunu henüz desteklemiyorsa, oyun kartından
  bota karşı veya aynı cihazda oynanabilir.
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
| `deploy/` | Kendi sunucuda yayın: `Dockerfile`, `compose.yml`, `yayin.sh`, güvenlik duvarı `sesli-oda-ag.sh`, dev ortamı (`dev/Caddyfile`, `dev-yayin.sh`), systemd birimleri (bkz. "Katkı ve yayın", "Geliştirme akışı") |
| `public/dev.js` | dev.agalar.app'te üstteki DEV etiketi (canlıda bir şey yapmaz) |
| `.github/workflows/test.yml` | PR'larda ve `dev`'e gönderimde `npm test` |
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
ve tema (ev sahibinin teması) ortak olur. Her odadan en fazla 10, toplam 20 kişi. Yönetici isterse hemen
birleşir. Reddedilen ya da süresi dolan istekten sonra aynı yöne 60 saniye yeni istek yok; bir hesap
dakikada en çok 3 istek gönderir. "Odaları ayır" ile herkes kendi odasına, kendi temasıyla döner.
Birleşme yalnız hafızadadır: sunucu yeniden başlarsa odalar ayrı açılır.

**Susturma:** Odadakiler kutusunda bir kişinin "Yönet" (üç nokta) düğmesi "Sustur"u açar. Susturulanın
mikrofonu ve ekran paylaşımının sesi kapanır ve kilitlenir; ses efekti çalamaz ve yükleyemez; öteki herkes, o
kişiden ne gelirse gelsin sesini çalmaz. Sohbete kimin susturduğu yazılır; kaldırılınca kişi mikrofonunu kendisi
açar. Kurallar:
- Köken, kişinin girdiği kapının odasıdır (birleşik odada da). Odalar arasında susturma kopyalanmaz.
- Oda sahibinin susturması odaya bağlıdır ve yalnız o odanın kapısından girene uygulanır. Birleşikken öteki
  odanın kapısından giren kişiye uygulanmaz; o kapının sahibi (aynı birleşik odadadır) ya da yönetici susturur.
- Yöneticinin susturması hesaba bağlıdır: her odada, her kapıdan, birleşmede ve sonrasında geçerlidir; yalnız
  yönetici kaldırır (hafızadadır: sunucu yeniden başlarsa kalkar). Kişinin susturması: yöneticininki, yoksa
  kökeninin sahip susturması.
- Yönetici herkesi susturur ve kaldırır; kaldırınca kişinin her odadaki sahip susturması da kalkar. Sahip kökeni kendi
  odası olanları (yönetici ve yöneticinin susturduğu hariç) susturur ve kaldırır. Kimse kendini susturamaz.
- Sahip susturması oda kapanınca ya da o odanın kökenlilerinden canlı odalarda ve yenileme payında kimse
  kalmayınca silinir; odadan çıkıp dönen yine susturulmuştur.

## Temalar

Görünümün bütün renkleri, yazı tipleri, köşeleri ve gölgeleri değişkendir; değişken sözleşmesi
`public/css/base.css`'in başında yazılıdır. Kurallarda sabit renk yazılmaz. Oda sahibi temayı oda
ayarlarından seçip "Uygula"ya basar; odadaki herkeste sayfa yenilenmeden değişir. Oda listesi ve giriş ekranı
her zaman varsayılan temadadır (Gece Odası). Temalar: Gece Odası (`gece`, koyu, varsayılan), Aydınlık Oda
(`aydinlik`, açık), Piksel Oda (`piksel`, retro oyun: kendi piksel yazı tipleri ve piksel ikon seti), Kış Odası
(`kis`, soğuk mavi gece; boyalı kar taneleriyle kar yağışı ve kış süsleri: boyalı kardan adam ve bulutlar
`public/themes/kis/` altında, buz sarkıtları ile kar yığınları tema dosyasında gömülü SVG; boş oynatıcıda iki chibi
kartopu atışır, sahne `test/tools/kis-scene.js` ile üretilir; hızlı emoji satırı da kışa göre, `app.js`
`THEME_QUICK_EMOJIS`)) ve Neon Oda
(`neon`, koyu mor-lacivert zemin, kutularda ve düğmelerde "uzay simi" kenarlar: renkli degrade üstünde sim noktaları;
masaüstünde sahne üç bölmeli bir oyun konsolu gibi dizilir: solda ince kişiler sütunu, sol kanatta ses kadranı ve
üçgen dizili araçlar, ortada 16:9 oynatıcı, sağ kanatta artı biçimli tuşlar ve büyük oynat düğmesi; altında zaman
çubuğu ve hemen altında yuvarlak sayfa düğmeleri (CSS anchor positioning ile çubuğa bağlı); hepsi tema dosyasının `@media (min-width: 1000px)`
bloğunda, HTML'e dokunmadan `display: contents` ve ızgara alanlarıyla. Ses kadranının yüzdesi `.vol`
kabının `data-val` değerinden okunur, `app.js` `paintRange` yazar. Telefonda düzen ortak).

Yeni tema eklemek (örnek kimlik `yeni`):

1. `public/themes/yeni.css`: sözleşmedeki bütün değişkenleri tanımlar (`public/themes/gece.css`'i kopyala).
   Metin kontrastı en az 4,5:1 olmalı. Kendi yazı tipi varsa `@font-face` bu dosyada (yalnız tema seçilince
   iner), dosyası lisansıyla `public/vendor/fonts/<ad>/` altında.
2. İkon seti: `public/icons/ui/<set>.svg`, `lucide.svg` ile aynı `i-…` adlarını taşır (lisansı yanına,
   `LICENSE-<set kaynağı>`). Üretici: `test/tools/icons.js`. Aynı seti kullanacaksa bu adım yok.
3. `public/theme.js`: `LIST`'e `'yeni'`, `NAMES`'e görünen ad, `ICON_SETS`'e ikon seti, `PREVIEW`'e oda
   kartı önizleme renkleri (bg, surface, text, accent).
4. `rooms.js`: `THEMES` dizisine `'yeni'` (sunucu tanımadığı temayı kabul etmez).
5. Önbellek: `public/theme.js`'teki `CSS_VERSION` ve `public/index.html`'deki `theme.js?v=…` etiketi değiştirilir
   (bir tema dosyası her değiştiğinde de; yoksa tarayıcılar saatlerce eski dosyayı kullanır).

## Dil (Türkçe / English)

Site Türkçe yazılır; İngilizce bir çeviri katmanıdır. Dil giriş kartından, hesap penceresinden ya da oda
ayarlarından seçilir (`localStorage.lang`); seçilmemişse tarayıcı dili `tr` değilse İngilizce açılır. Sayfa
yenilenmeden değişir.

- `public/i18n.js` (`<head>`'de, her şeyden önce): İngilizce seçiliyse ekrana çıkan her metni, `placeholder`,
  `title`, `aria-label` niteliklerini ve `alert/confirm/prompt` metnini sözlükten çevirir (MutationObserver).
  Kodda çağrılabilir: `I18N.t('Türkçe metin')`, `I18N.lang`, `I18N.locale` (tarih ve sayı biçimi), `langchange` olayı.
- Sözlük: `public/lang/en-ui.js` (site kabuğu), `en-games.js` (oyunlar), `en-server.js` (sunucunun gönderdiği
  sistem mesajları ve hatalar). Anahtar ekrandaki Türkçe metnin kendisidir; değişken parçalar `{0}`, `{1}`… ile
  yazılır ve çeviride yeniden sıralanabilir: `"{0} odaya katıldı": "{0} joined the room"`.
- Çevrilmeyenler: `translate="no"` taşıyan kutular ve `i18n.js`'teki `KEEP` seçicileri (sohbet mesajları,
  şarkı ve liste başlıkları, Daktilo/Kelime/Hızlı okuma kelimeleri; bu oyunların içeriği Türkçe kalır).
- Mantık tablosu bulmacayı sunucuda iki dilde üretir (`games/mantik.js` `clueTextEn`, oyuncuya `game.en`).
- CSS içindeki metinler (`content:`) `:lang(en)` kuralıyla değiştirilir (`public/css/games.css` sonu).

Yeni metin eklerken İngilizcesini ilgili sözlük dosyasına da yaz. Eksikleri bulmak için: siteyi İngilizce açıp
sayfada Türkçe karakter taşıyan metin düğümü aramak yeterli.

## Testler ve test sunucusu

```bash
npm test           # node --test --test-concurrency=1 test/*.test.js  (test/*.test.js, sırayla)
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

`main`'e giren her commit yaklaşık bir dakika içinde canlı sitede olur. `main`'e doğrudan push yapılmaz, yalnız
pull request ile girilir (bkz. "Geliştirme akışı"). Önce:

1. Değişikliği bilgisayarında test sunucusuyla (`PORT=<port> node -r ./test/preload.js server.js`) dene ve
   `npm test` çalıştır; tarayıcı konsolunda hata olmasın. `npm start` canlı veritabanına bağlandığı için
   deneme için kullanılmaz.
2. Ön yüz değişikliğini `dev` dalına gönderip dev.agalar.app'te dene, sonra `main`'e pull request aç (testler
   GitHub Actions'ta kendiliğinden çalışır).
3. Commit mesajlarını Türkçe ve ne yaptığını anlatacak şekilde yaz.

**Geçiş dönemi:** site Render'dan kendi sunucumuza taşınıyor. Geçiş onaylanana kadar Render servisi ve
`render.yaml` yerinde kalır (Render'da `CLIENT_IP_HEADER` ayarlı olmadığı için davranış orada değişmez); geçiş bir
hafta sorunsuz sürünce Render servisi silinir, `render.yaml` kaldırılır ve bu not güncellenir.
O zamana kadar Render'daki yayının durumu ve kayıtları Render panelindeki **Events** ve **Logs** sekmelerindedir.

### Kendi sunucuda yayın

Uygulama sunucuda bir Docker konteynerinde çalışır ve dışarıya port açmaz; ziyaretçiler Cloudflare Tunnel
üzerinden gelir (`tunnel` konteyneri Cloudflare'e kendisi bağlanır, yalnız `app:3030`'a iletir).

**Her yayında birkaç saniye kesinti olur; bozuk bir commit'te ~1 dakika** (yeni konteyner sağlık denetimini
bekler, geçemezse önceki sürüm geri açılır). Eski ve yeni sunucu hiçbir an birlikte çalışmaz: oda durumu
zaten hafızada ve her yeniden başlatmada sıfırlanıyor, aynı veritabanına iki sunucunun yazması daha kötü olurdu.

Sunucudaki yerleşim:

| Yol | Sahibi, izin | Ne |
| --- | --- | --- |
| `/srv/sesli-oda/` | `root:sesli-oda 750` | Kök dizin |
| `/srv/sesli-oda/app/` | `sesli-oda` | Bu deponun git kopyası; yayın betiği belli bir commit'e geçirir |
| `/srv/sesli-oda/compose.yml` | `root:root 644` | **Kullanılan** compose dosyası: `deploy/compose.yml`'nin gözden geçirilmiş kopyası |
| `/srv/sesli-oda/Dockerfile` | `root:root 644` | **Kullanılan** Dockerfile: `deploy/Dockerfile`'ın gözden geçirilmiş kopyası |
| `/srv/sesli-oda/.env` | `root:root 600` | Sırlar: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, `YT_API_KEY`, `CLIENT_IP_HEADER=cf-connecting-ip`, `TUNNEL_TOKEN`. Git'e girmez. |
| `/srv/sesli-oda/state/` | `root 755` | Yayın betiğinin kayıtları (başarısız ya da sabitlenmiş commit, uyarılar) ve geçici derleme arşivi |
| `/run/sesli-oda-yayin/lock` | `root 700` dizin | Yayın kilidi (iki yayın aynı anda çalışmaz) |
| `/usr/local/sbin/sesli-oda-yayin` | `root:root 755` | `deploy/yayin.sh`'nin kopyası |
| `/usr/local/sbin/sesli-oda-ag` | `root:root 755` | `deploy/sesli-oda-ag.sh`'nin kopyası (güvenlik duvarı) |
| `/etc/systemd/system/sesli-oda-yayin.{service,timer}`, `sesli-oda-ag.service` | `root:root 644` | `deploy/` altındakilerin kopyası |

- `deploy/compose.yml` (kaynak) ve onaylı kopyası: compose projesi `sesli-oda`; `app` (kullanıcı `1000:1000`,
  salt-okunur dosya sistemi, yetenek yok, 512 MB, sağlık denetimi `GET /theme-list`) ve `tunnel`
  (`cloudflare/cloudflared`). Kendi ağı `sesli-oda` (`172.31.240.0/28`, yalnız IPv4), port yayınlanmaz. Sırlar
  compose'a `--env-file /srv/sesli-oda/.env` ile verilir ve her konteyner yalnız kendi değişkenlerini alır
  (`app` tünel anahtarını, `tunnel` Supabase anahtarını görmez). Kullanıcı ve sağlık denetimi compose'ta sabit.
  İki konteynere de DNS olarak `1.1.1.1` ve `9.9.9.9` verilir: sunucunun kendi üst DNS'i özel bir adreste
  (`10.114.15.254`), Docker'ın gömülü DNS'i onu konteynerin ağ ad alanından sorar ve güvenlik duvarı özel ağlara
  gideni düşürür. `app`/`tunnel` adlarını gömülü DNS yine kendisi çözer.
- `deploy/Dockerfile` (kaynak) ve onaylı kopyası `/srv/sesli-oda/Dockerfile`: `node:22-alpine`,
  `npm ci --omit=dev --ignore-scripts` (bağımlılıkların kurulum betikleri çalışmaz; express ve socket.io
  ağacında kurulum betiği olan paket yok), yalnız `package*.json`, kökteki `*.js`, `games/` ve `public/`
  kopyalanır. Köke yeni bir klasör eklenirse Dockerfile'a (ve boyut için `.dockerignore`'a) da eklenmeli.
- Günlükler journald'de: `journalctl -t sesli-oda-sesli-oda-app-1 -f` (tünel `...-tunnel-1`), yayın betiği
  `journalctl -u sesli-oda-yayin`.

**Yayın (`sesli-oda-yayin`, zamanlayıcıyla dakikada bir):** `origin/main`'i çeker; yeni commit varsa imajı
o commit'in temiz arşivinden (`git archive`; çalışma ağacı ve `.git` değil) ve kurulu Dockerfile'dan
`sesli-oda-app:<kısa sha>` olarak kurar, `app`'i onunla yeniden başlatır ve 60 saniye içinde sağlık denetiminden
geçmesini bekler. Geçerse imaj `current` etiketini alır (son sağlıklı sürüm). Kurulamaz, başlatılamaz ya da
geçemezse (ör. log'da `SUNUCU AÇILMIYOR`) `current` yeniden başlatılır, betik hata koduyla çıkar ve o commit'i
bir daha kendiliğinden denemez. Son 3 imaj tutulur. Başarılı bir yayında `app` bir kez yeniden yaratılır.
Konteyner açılıyorsa (`starting`) tur atlanır; yayındaki sürüm sağlıksızsa ya da sürekli çöküyorsa
(`restarting`, `exited`) aynı sürüm otomatik olarak yeniden yaratılmaz ve her turda `SİTE KAPALI: ...` satırı
yazılır (yeni ve önceki sürüm de açılmadıysa da).
- **Compose ve Dockerfile değişikliği kendiliğinden devreye girmez.** Compose her zaman
  `/srv/sesli-oda/compose.yml`'den (`--project-directory /srv/sesli-oda/app`), Dockerfile her zaman
  `/srv/sesli-oda/Dockerfile`'dan okunur. Depodaki `deploy/compose.yml` ya da `deploy/Dockerfile` kurulu kopyadan
  farklıysa yine kurulu kopya kullanılır ve commit başına bir kez `UYARI: compose değişti, kurulu kopya
  kullanılıyor: elle güncelle` (ya da `Dockerfile değişti, …`) yazılır. Aynısı `deploy/yayin.sh`,
  `deploy/sesli-oda-ag.sh` ve systemd birimleri için geçerli: depoda değişince sunucuya elle kopyalanır
  (aşağıda "Kurulu kopyaları güncelleme").
- **Kurulum sırasında depoya bağlı kalan risk:** main'e push yapabilen biri yalnız (a) imaja kopyalanan
  dosyaları (kökteki `*.js`, `games/`, `public/`, `package*.json`) ve (b) `package-lock.json`'un hangi kayıt
  paketlerini (npm) sabitlediğini değiştirebilir. Kurulum adımları, kurulum ağı, `ADD` ile dışarıdan dosya
  çekme, temel imaj ve bağımlılık kurulum betikleri kurulu Dockerfile'da ve `--ignore-scripts` ile sabittir;
  derleme bağlamı arşiv olduğundan bağlamdaki sembolik bağlar dışarıyı (ör. `.env`) gösteremez. Yani kötü niyetli
  bir push kötü kod ya da kötü bir npm paketi yayınlayabilir (Render'da da böyleydi), ama kurulum sırasında
  sunucunun iç ağına ya da dosyalarına uzanamaz.
- **Elle yayın ve geri alma:** `ssh otomasyon sudo sesli-oda-yayin <sha>` o commit'i yayınlar (main'in
  geçmişinde olmalı; imajı hâlâ duruyorsa yeniden kurulmaz). Eski bir commit'e dönülünce otomatik yayın main'e
  yeni bir commit gelene kadar durur. Başarısız olmuş bir commit de aynı komutla yeniden denenir. Başka bir yayın
  sürerken elle çağrı hata verir; biraz sonra tekrar denenir.
- Compose'u elle çalıştırmak:
  `sudo docker compose -f /srv/sesli-oda/compose.yml --project-directory /srv/sesli-oda/app --env-file /srv/sesli-oda/.env ps`.
  Elle `up -d` (APP_TAG olmadan) `app`'i `current` etiketiyle **yeniden yaratır** (yayın betiği onu sha
  etiketiyle başlatmıştı): birkaç saniye kesinti. `--env-file` unutulursa compose zorunlu değişken hatasıyla durur. **Kabuktaki ortam değişkenleri
  `--env-file` değerlerinin önüne geçer:** `sudo -E` kullanılmaz, kabukta `SUPABASE_*`, `APP_TAG` gibi
  değişkenler tanımlı olmamalı.

**Sunucu güvenlik duvarı (`sesli-oda-ag`):** konteyner ağından (`172.31.240.0/28`) sunucunun kendisine giden her
şey (`INPUT`) ve özel/iç ağlara (`10/8`, `172.16/12`, `192.168/16`, Tailscale `100.64/10`, `169.254/16`) giden her
şey (`DOCKER-USER`) düşer; app ile tunnel arası ve internet açıktır. Kurallar yalnız IPv4 (compose ağında IPv6
yok). Docker her açıldığında `sesli-oda-ag.service` kuralları yeniden kontrol eder (tekrar çalıştırmak güvenli);
`sudo sesli-oda-ag kaldir` yalnız bu kuralları siler. Başka birimlerin `DOCKER-USER` kurallarına dokunulmaz.
**Kapsam dışı:** imaj kurulumu (`docker build`) Docker'ın varsayılan kurulum ağında ve host'un ağında çalışır ve bu
kurallara takılmaz; bu yüzden kurulum adımları depodan değil, kurulu Dockerfile'dan gelir (yukarıda "Kurulum
sırasında depoya bağlı kalan risk"). Docker açılırken konteynerler kurallardan birkaç saniye önce başlayabilir.
Yayın birimi güvenlik duvarı birimine bağlıdır (`Requires=`): kurallar yüklenemezse yayın yapılmaz.

**İlk kurulum (bir kez, root):**

```bash
useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin sesli-oda
install -d -o root -g sesli-oda -m 750 /srv/sesli-oda
install -d -o sesli-oda -g sesli-oda -m 755 /srv/sesli-oda/app
setpriv --reuid=sesli-oda --regid=sesli-oda --init-groups --reset-env \
  git clone https://github.com/osman-selim-yalcin/sesli-oda.git /srv/sesli-oda/app
install -d -o root -g root -m 755 /srv/sesli-oda/state
install -o root -g root -m 600 /dev/null /srv/sesli-oda/.env   # sonra değerler yazılır (editörle)
cd /srv/sesli-oda/app/deploy
install -o root -g root -m 644 compose.yml /srv/sesli-oda/compose.yml
install -o root -g root -m 644 Dockerfile /srv/sesli-oda/Dockerfile
install -o root -g root -m 755 yayin.sh /usr/local/sbin/sesli-oda-yayin
install -o root -g root -m 755 sesli-oda-ag.sh /usr/local/sbin/sesli-oda-ag
install -o root -g root -m 644 sesli-oda-yayin.service sesli-oda-yayin.timer sesli-oda-ag.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sesli-oda-ag.service          # kurallar; iptables -L DOCKER-USER -n ile bak
cd /                                                 # depo dizininden çık (yayın checkout'u değiştirir)
sesli-oda-yayin                                      # ilk yayın elle: imaj, app, sonra tunnel
                                                     # (kilit dizini /run/sesli-oda-yayin root 700 açılır)
systemctl enable --now sesli-oda-yayin.timer
```

`.env`'de `$` geçen bir değer varsa tek tırnağa alınır (compose onu değişken sanar).

**Sunucu yeniden açılınca:** Docker açılır, `restart: unless-stopped` ile `app` ve `tunnel` kendi imajlarıyla
(son başarılı yayının sha etiketli imajı; compose yeniden değerlendirilmez) kalkar, `sesli-oda-ag.service` kuralları ekler, zamanlayıcı 1 dakika sonra yayın turlarına
başlar. Elle bir şey gerekmez.

**Kurulu kopyaları güncelleme** (depoda `deploy/` altında bir şey değişince ya da yayın günlüğünde `UYARI: …
değişti` görülünce). Her dosya önce farkına bakılıp gözden geçirilir, yalnız değişen kopyalanır:

```bash
D=/srv/sesli-oda/app/deploy   # yönetici bu dizine giremez (750); komutlar sudo ile
for f in compose.yml Dockerfile; do sudo diff -u /srv/sesli-oda/$f $D/$f; done
sudo diff -u /usr/local/sbin/sesli-oda-yayin $D/yayin.sh
sudo diff -u /usr/local/sbin/sesli-oda-ag $D/sesli-oda-ag.sh
for f in sesli-oda-yayin.service sesli-oda-yayin.timer sesli-oda-ag.service; do sudo diff -u /etc/systemd/system/$f $D/$f; done

# compose: kopyala, sonra yeni ayarlarla yeniden yarat (APP_TAG yok: app current ile yeniden yaratılır, kesinti)
sudo install -o root -g root -m 644 $D/compose.yml /srv/sesli-oda/compose.yml
sudo docker compose -f /srv/sesli-oda/compose.yml --project-directory /srv/sesli-oda/app \
  --env-file /srv/sesli-oda/.env up -d
# Dockerfile: kopyala; bir sonraki yayında kullanılır (hemen denemek için: sudo sesli-oda-yayin <main'deki sha>)
sudo install -o root -g root -m 644 $D/Dockerfile /srv/sesli-oda/Dockerfile
# yayın betiği: bir sonraki zamanlayıcı turunda kullanılır
sudo install -o root -g root -m 755 $D/yayin.sh /usr/local/sbin/sesli-oda-yayin
# güvenlik duvarı betiği: eski kuralları kaldır, yenisini kur
sudo sesli-oda-ag kaldir
sudo install -o root -g root -m 755 $D/sesli-oda-ag.sh /usr/local/sbin/sesli-oda-ag && sudo systemctl restart sesli-oda-ag
# birimler
sudo install -o root -g root -m 644 $D/sesli-oda-yayin.service $D/sesli-oda-yayin.timer $D/sesli-oda-ag.service \
  /etc/systemd/system/ && sudo systemctl daemon-reload
```

Dockerfile yeni bir kurulu kopyayla aynı commit'i yeniden kurmak gerekirse (imaj o sha ile zaten var olduğu için
betik yeniden kurmaz) önce o imaj silinir: `sudo docker image rm sesli-oda-app:<kısa sha>` (yayında değilse).

**Sunucuda denetlenecekler** (kurulumda ve ara sıra):

- `172.31.240.0/28` başka bir Docker ağıyla ya da sunucunun bir arayüzüyle çakışmıyor mu
  (`docker network inspect $(docker network ls -q) | grep Subnet`, `ip -4 addr`).
- Docker kurulum önbelleği büyüyor mu (`docker system df`); gerekirse `docker builder prune --filter until=168h`.
- Sunucuda Docker etiketlerine bakarak iş yapan bir servis (ör. Traefik, Watchtower, otomatik yedek) var mı;
  varsa `sesli-oda` konteynerlerini kendiliğinden yayınlamadığından ya da güncellemediğinden emin olunur.
- Güvenlik duvarı gerçekten çalışıyor mu: `sudo docker exec sesli-oda-app-1 node -e "fetch('http://<sunucunun iç
  adresi>:22').catch(e=>console.log('engelli',e.cause?.code))"` zaman aşımı vermeli; ad çözme ve internet açık
  olmalı: `... node -e "require('dns').promises.lookup('supabase.co').then(console.log)"` ve `lookup('tunnel')`
  (compose'taki `dns: [1.1.1.1, 9.9.9.9]` sayesinde). `sudo iptables -L INPUT -v -n | grep sesli-oda` sayaçları
  DNS sorgusunda artmamalı.

**Gerçek ziyaretçi adresi (`CLIENT_IP_HEADER`):** giriş, şifre değiştirme, oda şifresi ve kayıt olma sınırları
ziyaretçi adresine göre sayılır (IPv6'da adresin /64 öneki). Tünel arkasında `CLIENT_IP_HEADER=cf-connecting-ip`
ayarlanır: adres bu başlıktan alınır; başlık yoksa ya da geçerli tek bir adres değilse bağlantının kendi adresi
kullanılır, `X-Forwarded-For`'a bakılmaz ve günlüğe uyarı yazılır (en fazla 10 dakikada bir). Bu ayar yalnız
uygulamaya Cloudflare dışından ulaşılamıyorsa güvenlidir (başlığı istemci de yazabilir). Ayarlı değilse eski
kural geçerlidir (Render'ın vekili: `X-Forwarded-For`'un son değeri).

## Geliştirme akışı

- **`dev` dalı → https://dev.agalar.app** (dakikada bir). Dev ortamı **yalnız ön yüzdür:** `dev` dalının
  `public/` dizini olduğu gibi sunulur; API ve socket.io istekleri **canlı sunucuya** gider. Yani dev'de
  **canlı veritabanı** kullanılır: giriş yaptığın hesap, açtığın oda, yazdığın mesaj, kazandığın skor gerçektir.
  Dev'de deneme hesabı ya da deneme odası açarken bunu bil.
- **Sunucu değişiklikleri dev'de çalışmaz.** `server.js`, `accounts.js`, `rooms.js`, `games/` gibi dosyalardaki
  değişiklikler sunucuda yalnız `main`'e girince çalışır; dev'de testlerle (`npm test`, GitHub Actions) ve yerel
  test sunucusuyla denenir. Yeni bir sunucu özelliğine ihtiyaç duyan bir dev ön yüzü, o özellik `main`'e girene
  kadar dev'de çalışmaz (ör. yeni bir uç 404 döner).
- **`main` yalnız pull request ile değişir.** PR açılınca ve `dev`'e her gönderimde `.github/workflows/test.yml`
  `npm ci` ve `npm test` çalıştırır (sır kullanmaz, ağ gerekmez). PR birleşince canlı yayın kendiliğinden olur.
- Dev sayfasının üstünde küçük kırmızı bir **DEV** etiketi görünür (`public/dev.js`; yalnız `dev.` ile başlayan
  adreste çalışır, canlıda bir şey yapmaz). Dev arama motorlarına kapalıdır (`X-Robots-Tag: noindex`); html, js ve
  css her açılışta yeniden doğrulanır (`Cache-Control: no-cache`), ses efektleri, yazı tipleri ve ikonlar
  önbellekte kalır.

### Dev yayını nasıl çalışır

- `sesli-oda-dev-yayin` (`deploy/dev-yayin.sh`, zamanlayıcıyla dakikada bir, root): ortak git kopyasında
  (`/srv/sesli-oda/app`) yalnız `origin/dev`'i çeker; **checkout yapmaz** (çalışma ağacı canlı yayının). Yeni
  commit varsa önce o commit'in `public/` ağacını git'te denetler: yalnız düz dosya ve dizin (sembolik bağ ya da alt
  modül varsa reddedilir), her yol `public/` altında, en çok 5000 dosya ve 200 MB. Sonra yalnız `public/`'in
  arşivini (`git archive <sha> public`) root'a ait yeni bir dizine açar (`/srv/sesli-oda/dev/www/releases/<kısa
  sha>/public`), `current` sembolik bağını atomik olarak ona çevirir ve commit'i `/srv/sesli-oda/state/dev-rev`'e
  yazar. Son 3 sürüm tutulur. Konteyner yeniden başlatılmaz. Reddedilen commit tekrar denenmez (günlükte
  `REDDEDİLDİ:` ve `HATA:`); dev'deki sürüm aynen sunulmaya devam eder. `dev` dalı yoksa sessizce çıkar.
- Elle: `sudo sesli-oda-dev-yayin <sha>` (dev dalının geçmişinde olmalı). Eski bir commit'e dönülünce otomatik dev
  yayını dev'e yeni bir commit gelene kadar durur.
- `dev` konteyneri (Caddy, `deploy/dev/Caddyfile`): `:8080`, yalnız HTTP; `/srv/sesli-oda/dev/www` salt-okunur
  bağlıdır ve `current/public`'ten sunar. Sırası: canlının dinamik uçları (socket.io, `/auth/*`, `/rooms*`,
  `/admin/*`, `/config`, `/status`, `/search`, `/theme-list`, `/avatar/*`, `/img/*`, `/card-img/*`,
  `/sfx-custom/*`, `/radio/*`) her zaman canlı `app`'e; sayfa adresleri (`/uyeler`, `/oda/...`) dev'in
  `index.html`'i; dev'de var olan dosya dev'den; geri kalan her şey canlı `app`'e. Sunucuya yeni bir uç eklenince
  Caddyfile'daki listeye de eklenmeli. `Cf-Connecting-Ip` olduğu gibi geçer; bu yolda istemcinin taklit
  edebildiği bir şey doğrudan tünel yolundakinden fazla değildir.
- Kod çalıştırmaz, sır almaz, `.env` görmez; canlı yayın (`sesli-oda-yayin`) bu konteynere dokunmaz.

**Dev ortamını ilk kurma (bir kez, root; canlı kurulmuş olmalı):**

```bash
install -d -o root -g root -m 755 /srv/sesli-oda/dev /srv/sesli-oda/dev/www /srv/sesli-oda/dev/www/releases
D=/srv/sesli-oda/app/deploy   # bu dosyalar, commit'i main'e girip canlıya yayınlanınca checkout'ta olur
install -o root -g root -m 644 $D/dev/Caddyfile /srv/sesli-oda/dev/Caddyfile
install -o root -g root -m 755 $D/dev-yayin.sh /usr/local/sbin/sesli-oda-dev-yayin
install -o root -g root -m 644 $D/sesli-oda-dev-yayin.service $D/sesli-oda-dev-yayin.timer /etc/systemd/system/
sudo diff -u /srv/sesli-oda/compose.yml $D/compose.yml       # yalnız dev servisi eklenmiş olmalı
install -o root -g root -m 644 $D/compose.yml /srv/sesli-oda/compose.yml
systemctl daemon-reload
cd /
sesli-oda-dev-yayin                                         # ilk sürüm (dev dalı GitHub'da olmalı)
ls -l /srv/sesli-oda/dev/www                                # current -> releases/<kısa sha>
docker compose -f /srv/sesli-oda/compose.yml --project-directory /srv/sesli-oda/app \
  --env-file /srv/sesli-oda/.env up -d --no-deps dev
systemctl enable --now sesli-oda-dev-yayin.timer
```

Cloudflare'de (Zero Trust → Tunnels → `sesli-oda` → Public hostnames): `dev.agalar.app` → `http://dev:8080`.
`current` yokken `dev` açılırsa her şey 404 döner (sağlık denetimi de); önce ilk sürüm yayınlanır. Caddyfile
değişince kopyalanır ve `dev` yeniden başlatılır (`... restart dev`): tek dosya bağlaması eski dosyayı görmeye devam
eder. `dev` konteynerini durdurmak canlıyı etkilemez (`... stop dev`).

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

- Ses: Opus 32 kbps, sessizken neredeyse 0 (DTX). 5 kişiyle konuşurken ~10-20 MB/saat. Herkes herkese doğrudan
  bağlıdır: konuşan kişi sesini her dinleyene ayrı gönderir (10 kişide 9 × 32 kbps, birleşik odada 19 × 32 kbps).
- Ekran paylaşımı: görüntü her kişiye ayrı gider; kişi başı en çok 1 Mbps, toplam yükleme 6 Mbps'i geçmesin diye
  kalabalık odada kişi başı düşer (10 kişide ~670 kbps, 20 kişide ~315 kbps).
- Müzik/video: Herkes YouTube'dan kendi cihazında oynatır; uygulama sadece "oynat / durdur / şu saniye"
  komutlarını iletir. Asıl veri tüketimi YouTube videosunun kendisidir.

## Lisanslar

Ses efektlerinin kaynakları ve lisansları `public/sfx/KAYNAKLAR.txt` içinde; bu dosyayı silmeyin. Dört efekt
(Ding, Hüzün, Tada, Bum) CC BY 3.0 lisanslı ve atıf ister; uygulamada şu an atıf linki yok.
