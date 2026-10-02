# Sesli Oda

En fazla 6 kişilik sesli sohbet + senkronize YouTube izleme/dinleme.

**Canlı:** https://agalar.app

## Neler var

- Sesli sohbet (WebRTC, Opus); gürültü kapısı ve ses eşiği ayarı
- Herkeste aynı anda oynayan YouTube; site içi arama ve oynatma geçmişi
- Yazılı sohbet, emoji seçici
- Ses efektleri; herkes kendi efektini de yükleyebilir
- Ekran paylaşımı (Chrome/Edge'de sekme sesiyle birlikte)
- Ses kaydı: müzik dahil ya da sadece konuşmalar, MP3 veya WebM olarak iner. Kayıt sadece kaydedenin
  bilgisayarına iner, sunucuya gitmez.

## Bilgisayarında çalıştırma

Node.js 20 veya üstü gerekir.

```bash
npm install
npm start          # http://localhost:3030
```

`localhost` üzerinde mikrofon HTTPS olmadan da çalışır. Birden fazla kişiyi denemek için aynı adresi
birkaç sekmede aç.

## Proje yapısı

Derleme adımı yok; `public/` içindeki dosyalar olduğu gibi sunulur.

| Dosya | Ne işe yarar |
| --- | --- |
| `server.js` | Express + Socket.IO: odalar, sinyalleşme, sohbet, YouTube araması |
| `public/index.html`, `style.css` | Arayüz |
| `public/app.js` | İstemcinin tamamı: ses, YouTube, sohbet, kayıt |
| `public/sfx.js`, `public/sfx/` | Ses efektleri |
| `public/gate-worklet.js` | Mikrofon gürültü kapısı (AudioWorklet) |
| `public/rec-worklet.js`, `mp3-worker.js` | Kayıt ve MP3'e çevirme |
| `public/vendor/lame.min.js` | MP3 kodlayıcı (lamejs 1.2.1, LGPL); elle düzenlemeyin |

## Katkı ve yayın

`main` dalına yapılan her push, Render'da otomatik olarak yayına alınır. Yani **`main`'e giden her şey
birkaç dakika içinde canlı sitede olur.** Push'tan önce:

1. Değişikliği bilgisayarında `npm start` ile dene; tarayıcı konsolunda hata olmasın.
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
| `PORT` | Sunucu portu (varsayılan 3030; Render kendisi verir). |

## İnternet kullanımı

- Ses: Opus 32 kbps, sessizken neredeyse 0 (DTX). 5 kişiyle konuşurken ~10-20 MB/saat.
- Müzik/video: Herkes YouTube'dan kendi cihazında oynatır; uygulama sadece "oynat / durdur / şu saniye"
  komutlarını iletir. Asıl veri tüketimi YouTube videosunun kendisidir.

## Lisanslar

Ses efektlerinin kaynakları ve lisansları `public/sfx/KAYNAKLAR.txt` içinde. CC BY 3.0 olanların atfı
uygulamadaki "Ses kaynakları" linkinde görünür; bu dosyayı silmeyin.
