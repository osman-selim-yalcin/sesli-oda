# Sesli Oda sunucusu. Kurulum deponun kökünden: docker build -f deploy/Dockerfile .
# Yalnız sunucunun ihtiyacı kopyalanır (testler, .git, db/, deploy/ girmez; ayrıca kökteki .dockerignore).
FROM node:22-alpine

ENV NODE_ENV=production PORT=3030
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Kökteki sunucu modülleri (server.js, accounts.js, rooms.js, ...), oyunlar ve istemci dosyaları.
# Köke yeni bir klasör eklenirse buraya da eklenmeli; eklenmezse yeni sürüm sağlık denetiminden geçemez.
COPY *.js ./
COPY games/ ./games/
COPY public/ ./public/
# COPY dosya izinlerini olduğu gibi taşır; sunucudaki kopya dar izinli olsa da node kullanıcısı okuyabilsin.
RUN chmod -R a+rX,go-w /app

# Dosyalar root'a ait kalır; süreç kök olmayan node kullanıcısıyla çalışır ve onları değiştiremez.
USER node
EXPOSE 3030

# alpine'da curl yok: Node'un kendi fetch'i. Açılışta Supabase okunur, sonra port dinlenir.
# Kullanıcı ve sağlık denetimi sunucuda kurulu compose kopyasında da yazılıdır (o kazanır).
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3030/theme-list').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server.js"]
