/** Transcribed from the prototype's `srcMeta`. Keys double as article ids. */
export type Source = { k: string; tile: string; name: string; meta: string };

export const SOURCES: Source[] = [
  { k: 'oa', tile: 'OA', name: 'OpenAI Blog', meta: 'Modeller · EN' },
  { k: 'an', tile: 'AN', name: 'Anthropic', meta: 'Ürün · EN' },
  { k: 'gd', tile: 'GD', name: 'Google DeepMind', meta: 'Araştırma · EN' },
  { k: 'hf', tile: 'HF', name: 'Hugging Face', meta: 'Açık Kaynak · EN' },
  { k: 'ax', tile: 'AX', name: 'arXiv cs.AI', meta: 'Araştırma · EN' },
  { k: 'tc', tile: 'TC', name: 'TechCrunch AI', meta: 'Ürün · EN' },
  { k: 'wz', tile: 'WZ', name: 'Webrazzi AI', meta: 'Türkiye · TR' },
];
