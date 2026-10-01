# Sesli Oda

En fazla 6 kişilik sesli sohbet + senkronize YouTube izleme/dinleme.

## Çalıştırma

```bash
npm install
npm start          # http://localhost:3030
```

## Arkadaşlarınla kullanmak

Mikrofon için tarayıcı HTTPS ister, bu yüzden uygulamayı internete açman gerekir:

- **Hızlı deneme (bilgisayarın açıkken):** `brew install cloudflared` → `cloudflared tunnel --url http://localhost:3030`
  Verdiği `https://...trycloudflare.com` linkini arkadaşlarına gönder.
- **Kalıcı:** Projeyi GitHub'a yükleyip Render.com'da "Web Service" olarak aç
  (Build: `npm install`, Start: `npm start`). Ücretsiz plan yeterli.

## İnternet kullanımı

- Ses: Opus 32 kbps, sessizken neredeyse 0 (DTX). 5 kişiyle konuşurken ~10-20 MB/saat.
- Müzik/video: Herkes YouTube'dan kendi cihazında oynatır; uygulama sadece "oynat / durdur / şu saniye" komutlarını iletir.
  Asıl veri tüketimi YouTube videosunun kendisidir.

## Bağlantı sorunu

Bazı mobil ağlarda doğrudan bağlantı kurulamayabilir ("Bağlanamadı"). O zaman bir TURN sunucusu ekle:
`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` ortam değişkenleri.
