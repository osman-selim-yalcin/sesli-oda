-- !!! ÇALIŞTIRMADAN ÖNCE DOĞRULA !!!
-- room_state tablosunun tanımı depoda yok. store.js satırları PostgREST'e
-- "Prefer: resolution=merge-duplicates" ile (room, kind, data, updated_at) olarak yazar; bu, tabloda
-- (room, kind) üzerinde birincil anahtar ya da benzersiz kısıt olduğunu gösterir ama depodan kesin
-- doğrulanamadı. Supabase SQL düzenleyicisinde önce şuna bak:
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'room_state'::regclass;
-- (room, kind) üzerinde primary key / unique görünmüyorsa aşağıdaki "on conflict (room, kind)" hata verir;
-- o zaman çalıştırma.
--
-- Çoklu oda canlıya geçiş: skor tabloları ve oyun önerileri bütün odalarda ortak.
-- Canlıya geçerken Supabase SQL düzenleyicisinde bir kez elle, yeni sunucu açılmadan önce çalıştırılır
-- (sunucu çalıştırmaz). Tek işlem: biri başarısız olursa hiçbiri yazılmaz.
-- ZAMANLAMA: kopya satırların tamamını değiştirir (data üzerine yazılır, birleştirilmez). Bu yüzden eski
-- sunucu durdurulmuşken (ya da tam geçiş anında) çalıştırılır: yeni sunucu 'ortak' satırlarına yazmaya
-- başladıktan sonra çalıştırılırsa o yazılanlar silinir; eski sunucu hâlâ 'genel' satırlarına yazabiliyorken
-- çalıştırılırsa sonradan yazılanlar 'ortak'a hiç geçmez.
-- (a) 'genel' odasının tabloları ve önerileri 'ortak' satırına kopyalanır; yeni sunucu bu türleri yalnız
--     'ortak' satırından okur. 'genel' satırları silinmez (geri dönüş için kalır, sunucu onları yok sayar).
-- (b) rooms tablosuna genel odası eklenir (sahibi osyalcin; accounts'ta 'osyalcin' hesabı olmalı).

begin;

insert into room_state (room, kind, data, updated_at)
select 'ortak', kind, data, now()
from room_state
where room = 'genel'
  and kind in ('dinoboard', 'memoryboard', 'klotskiboard', 'timingboard', 'daktiloboard', 'hedefboard', 'oneriler')
on conflict (room, kind) do update
  set data = excluded.data, updated_at = excluded.updated_at;

insert into rooms (id, name, owner_id)
values ('genel', 'genel', 'osyalcin')
on conflict do nothing;

commit;
