'use strict';

// Sık kullanılan Türkçe kelimeler. Daktilo düellosu (games/daktilo.js, sunucu require eder) ve hızlı okuma
// alıştırmaları (public/okuma.js) aynı listeyi kullanır. Hepsi küçük harf.
const TR_WORDS = `
ve bir bu da ne için ile çok daha gibi ama sonra şimdi her şey kadar olan diye ben sen o biz siz onlar
var yok evet hayır değil bile hem ya ki en iyi kötü büyük küçük yeni eski uzun kısa güzel çirkin kolay zor
gün gece sabah akşam öğle yıl ay hafta saat dakika zaman bugün yarın dün erken geç önce hemen biraz
ev oda kapı pencere masa sandalye yatak duvar mutfak bahçe sokak cadde şehir köy ülke dünya deniz göl nehir
dağ orman ağaç çiçek yaprak toprak taş kum su ateş hava rüzgar yağmur kar güneş bulut gökyüzü yıldız
insan adam kadın çocuk bebek anne baba kardeş abla abi dede nine arkadaş komşu öğretmen öğrenci doktor
iş okul ders sınav kitap defter kalem kağıt sayfa harf kelime cümle soru cevap konu fikir düşünce
yemek ekmek peynir zeytin çay kahve süt şeker tuz elma armut portakal üzüm domates biber patates
gelmek gitmek yapmak etmek olmak almak vermek bakmak görmek bilmek demek istemek bulmak kalmak
yaşamak çalışmak okumak yazmak konuşmak dinlemek anlamak düşünmek sevmek beklemek başlamak bitirmek
gel git yap al ver bak gör bil de iste bul kal yaşa çalış oku yaz konuş dinle anla düşün sev bekle
geldi gitti yaptı aldı verdi baktı gördü bildi dedi istedi buldu kaldı başladı bitti oldu
geliyor gidiyor yapıyor alıyor veriyor bakıyor görüyor biliyor diyor istiyor buluyor kalıyor
kırmızı mavi yeşil sarı beyaz siyah mor turuncu pembe gri kahverengi renk ışık ses müzik şarkı
araba otobüs tren uçak gemi bisiklet yol köprü durak istasyon yolculuk tatil plaj otel bilet
para fiyat ucuz pahalı çarşı pazar dükkan market alışveriş hediye paket kutu çanta ayakkabı
el ayak baş göz kulak burun ağız diş saç yüz kalp kol parmak sırt omuz bacak vücut sağlık
mutlu üzgün yorgun hasta açık kapalı sıcak soğuk ılık serin temiz kirli dolu boş hızlı yavaş
oyun takım maç gol top koşu yüzme spor kazanmak kaybetmek yarış puan skor tur sıra kural
telefon bilgisayar ekran haber mesaj resim film dizi kamera internet oda program uygulama
sevgi umut korku merak hayal rüya anı hikaye masal şiir roman yazar okur kültür sanat tarih
kedi köpek kuş balık at inek koyun tavuk arı kelebek aslan kaplan fil ayı tilki tavşan
bir iki üç dört beş altı yedi sekiz dokuz on yirmi otuz yüz bin ilk son orta yarım tam
nasıl neden nerede ne zaman kim hangi kaç belki mutlaka sadece yine artık hiç hep bazen sık
güzelce yavaşça sessizce birlikte yalnız beraber karşı yanında içinde dışında üstünde altında
`.trim().split(/\s+/).filter((w, i, all) => all.indexOf(w) === i);

if (typeof module !== 'undefined') module.exports = TR_WORDS;
