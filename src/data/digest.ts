/**
 * The digest screen is static in the prototype: five hand-written entries whose
 * titles differ from the feed articles. Kept as data so a later task can generate
 * them for real.
 */
export type DigestEntry = { no: string; title: string; line: string; meta: string };

export const DIGEST_DATE = '20 AĞUSTOS 2026 · PERŞEMBE';
export const DIGEST_HEADLINE = 'Bugünün AI Gündemi';
export const DIGEST_META = '5 haber · ~3 dk';

export const DIGEST: DigestEntry[] = [
  {
    no: '01',
    title: 'GPT-5.2 tanıtıldı: iki kat bağlam, yarı fiyat',
    line: 'API fiyatı token başına %50 düştü; 2M bağlam penceresi standart oldu.',
    meta: 'OpenAI Blog · Modeller',
  },
  {
    no: '02',
    title: 'AlphaFold 4 ilaç keşfini hızlandırıyor',
    line: 'Etkileşim tahminlerinde %30 isabet artışı; ağırlıklar akademiye açılıyor.',
    meta: 'Google DeepMind · Araştırma',
  },
  {
    no: '03',
    title: 'Mistral-Nano 12B telefonda çalışıyor',
    line: 'Açık ağırlıklı model, orta segment cihazlarda 30 token/sn üretiyor.',
    meta: 'Hugging Face · Açık Kaynak',
  },
  {
    no: '04',
    title: "AB Yapay Zekâ Yasası'nda ikinci faz",
    line: 'Genel amaçlı modeller için şeffaflık yükümlülükleri yürürlükte.',
    meta: 'TechCrunch AI · Ürün',
  },
  {
    no: '05',
    title: 'Türkçe LLM konsorsiyumundan ilk model',
    line: 'TÜBİTAK destekli 7B model, Türkçe kıyaslamalarda açık ara önde.',
    meta: 'Webrazzi · Türkiye',
  },
];
