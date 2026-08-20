/**
 * Mock content transcribed verbatim from the prototype's `arts()`
 * (`design/AI Gündem - Prototip.dc.html`). No network, no persistence — impl-001
 * ships the prototype's own five articles so later tasks have a UI to plug into.
 */
export type Category =
  | 'Modeller'
  | 'Araştırma'
  | 'Ürün'
  | 'Açık Kaynak'
  | 'Türkiye';

export type Article = {
  id: string;
  tile: string;
  src: string;
  time: string;
  cat: Category;
  title: string;
  /** Claude-generated Turkish summary bullets. */
  sum: string[];
  /** Turkish body (the translation). */
  body: string;
  /** Original English body. */
  en: string;
};

export const CATEGORIES = [
  'Tümü',
  'Modeller',
  'Araştırma',
  'Ürün',
  'Açık Kaynak',
  'Türkiye',
] as const;

export type Filter = (typeof CATEGORIES)[number];

export const ARTICLES: Article[] = [
  {
    id: 'oa',
    tile: 'OA',
    src: 'OpenAI Blog',
    time: '2 saat önce',
    cat: 'Modeller',
    title: 'GPT-5.2 tanıtıldı: iki kat bağlam penceresi, yarı fiyat',
    sum: [
      'API fiyatı token başına %50 düştü; 2M bağlam standart oldu.',
      'Gerçek zamanlı ses modu tüm planlara açıldı.',
      'Kod ajanları için yeni araç çağırma protokolü geldi.',
    ],
    body: 'OpenAI, GPT-5.2 ile bağlam penceresini 2 milyon tokena çıkarırken API fiyatını yarıya indirdiğini duyurdu. Şirket, yeni sürümün özellikle uzun doküman analizi ve çok adımlı ajan görevlerinde belirgin fark yarattığını söylüyor…',
    en: 'OpenAI announced GPT-5.2, doubling the context window to 2M tokens while cutting API prices in half. The company says the new release makes a visible difference on long-document analysis and multi-step agent tasks…',
  },
  {
    id: 'an',
    tile: 'AN',
    src: 'Anthropic',
    time: '4 saat önce',
    cat: 'Ürün',
    title: "Claude'a takım hafızası geldi: projeler arası kalıcı bağlam",
    sum: [
      'Hafıza, proje bazında açılıp kapatılabiliyor.',
      'Ekip üyeleri arasında paylaşımlı bilgi tabanı.',
      'Kurumsal planlarda bugün itibarıyla aktif.',
    ],
    body: 'Anthropic, Claude için projeler arası kalıcı hafızayı duyurdu. Özellik, ekiplerin tekrar eden bağlam aktarımını ortadan kaldırıyor; hafıza istenirse proje bazında kapatılabiliyor…',
    en: 'Anthropic announced persistent cross-project memory for Claude. The feature removes repeated context handoffs for teams; memory can be disabled per project…',
  },
  {
    id: 'gd',
    tile: 'GD',
    src: 'Google DeepMind',
    time: '6 saat önce',
    cat: 'Araştırma',
    title: 'AlphaFold 4, ilaç etkileşimlerini %30 daha isabetli öngörüyor',
    sum: [
      'Protein–ilaç etkileşim tahminlerinde %30 isabet artışı.',
      'Klinik öncesi aday taraması haftalardan saatlere iniyor.',
      'Ağırlıklar akademik kullanım için önümüzdeki ay açılacak.',
    ],
    body: "DeepMind ekibi, AlphaFold 4'ün yalnızca protein yapısını değil, küçük molekül etkileşimlerini de tek geçişte modellediğini açıkladı. Yeni mimari, bağlanma afinitesi tahminlerinde bağımsız kıyaslamalarda öne çıktı…",
    en: 'The DeepMind team revealed that AlphaFold 4 models not only protein structure but small-molecule interactions in a single pass. The new architecture leads independent benchmarks on binding-affinity prediction…',
  },
  {
    id: 'hf',
    tile: 'HF',
    src: 'Hugging Face',
    time: '8 saat önce',
    cat: 'Açık Kaynak',
    title: 'Mistral-Nano 12B açık ağırlıkla yayınlandı — telefonda çalışıyor',
    sum: [
      'Orta segment telefonlarda 30 token/sn üretim.',
      'Apache 2.0 lisansı ile tam açık ağırlık.',
      '4-bit kuantize sürüm 6 GB RAM ile yetiniyor.',
    ],
    body: "Mistral'in 12 milyar parametrelik yeni modeli açık ağırlıkla yayınlandı. Topluluk testlerinde model, orta segment telefonlarda saniyede ~30 token üretebiliyor…",
    en: "Mistral's new 12B model shipped with open weights. In community tests the model generates ~30 tokens/s on mid-range phones…",
  },
  {
    id: 'wz',
    tile: 'WZ',
    src: 'Webrazzi',
    time: 'dün',
    cat: 'Türkiye',
    title: 'TÜBİTAK destekli Türkçe LLM konsorsiyumu ilk modelini duyurdu',
    sum: [
      '7B model Türkçe kıyaslamalarda açık ara önde.',
      'Üniversite-sanayi ortaklığıyla eğitildi.',
      'Ağırlıklar araştırmacılara açılacak.',
    ],
    body: 'TÜBİTAK destekli konsorsiyum, ilk Türkçe odaklı büyük dil modelini duyurdu. 7 milyar parametrelik model, Türkçe anlama kıyaslamalarında mevcut açık modellerin önüne geçti…',
    en: 'The TÜBİTAK-backed consortium announced its first Turkish-focused LLM. The 7B model surpasses existing open models on Turkish understanding benchmarks…',
  },
];

/** Prototype fallback when `artId` matches nothing: `arts.find(...) || arts[2]`. */
export const FALLBACK_ARTICLE_INDEX = 2;
