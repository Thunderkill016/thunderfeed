/**
 * Canonical entity normalization — the ONE gazetteer shared by initial
 * clustering (cluster.ts), the persistent Event Resolver (writer.ts),
 * and benchmark feature computation. Gazetteer-only, deterministic
 * canonical slugs; vi+en aliases collapse to one identity
 * ("Hoa Kỳ"/"Mỹ"/"US" → "us").
 *
 * Purpose is NOT full NER — it is the contradiction guard and the
 * identity anchor: two events naming different places must never merge
 * on a shared generic claim.
 *
 * Two matching surfaces exist because callers hold two text forms:
 *   extractEntities(text)      — raw text, NFC, diacritics preserved.
 *                                "nhà trắng" → us, "nha trang" → nhatrang.
 *   injectEntityTokens(norm)   — normalized (diacritics-stripped) text,
 *                                rewrites matched spans inline to
 *                                " entity_<slug> " so keyword/bigram
 *                                pipelines see the same identity.
 * Ambiguity note: normalized text cannot separate "nha trang" (city)
 * from "nhà trắng" (White House) — the city wins on the normalized
 * surface; the raw surface keeps them distinct.
 */

import { normalizeText } from "./model";

interface EntityDef {
  slug: string;
  /** literal alias phrases — matched word-bounded, case/diacritic-aware */
  aliases: string[];
  /** extra regex fragments on the RAW surface (punctuation forms, guards) */
  raw?: string[];
  /** regex fragments on the NORMALIZED surface — defaults to raw. Guards
   *  must be rewritten without diacritics ("bà"→"ba") because the input
   *  is already normalized */
  norm?: string[];
}

const E = (
  slug: string,
  aliases: string[],
  raw?: string[],
  norm?: string[],
): EntityDef => ({
  slug,
  aliases,
  raw,
  norm,
});

/*
 * Collision audit (normalized surface is diacritics-blind):
 *  - "anh"/"ý"/"áo"/"đức"/"séc"/"ai" are common Vietnamese words — they
 *    can NEVER be bare aliases (anh=brother/photo, ý=idea, áo=shirt,
 *    đức=name, séc=cheque, ai=who). Only qualified forms remain.
 *  - "nha trang" normalized = city AND "nhà trắng" (White House) — city
 *    wins; White House still resolves on raw text / "white house".
 *  - "pháp"/"mỹ"/"nga" are real entity names but collide with
 *    "pháp luật", "mỹ phẩm", personal name "Nga" — guarded by
 *    follow/precede exclusions below.
 */
const GAZETTEER: EntityDef[] = [
  /* ---- Vietnam & major localities ---- */
  E("vietnam", ["việt nam", "vietnam", "viet nam", "vietnamese"]),
  E("hanoi", ["hà nội", "ha noi", "hanoi"]),
  E("hcmc", [
    "tp.hcm",
    "tp hcm",
    "tphcm",
    "hồ chí minh",
    "ho chi minh",
    "sài gòn",
    "sai gon",
  ]),
  E("danang", ["đà nẵng", "da nang", "danang"]),
  E("haiphong", ["hải phòng", "hai phong", "haiphong"]),
  E("cantho", ["cần thơ", "can tho"]),
  E("hue", ["huế", "hue"]),
  E("nhatrang", ["nha trang"]),
  E("dalat", ["đà lạt", "da lat"]),
  E("quangninh", ["quảng ninh", "quang ninh"]),
  E("hatinh", ["hà tĩnh", "ha tinh"]),
  E("nghean", ["nghệ an", "nghe an"]),
  E("thanhhoa", ["thanh hóa", "thanh hoa"]),
  E("laocai", ["lào cai", "lao cai"]),
  E("langson", ["lạng sơn", "lang son"]),
  E("caobang", ["cao bằng", "cao bang"]),
  E("dienbien", ["điện biên", "dien bien"]),
  E("sonla", ["sơn la", "son la"]),
  E("gialai", ["gia lai"]),
  E("daklak", ["đắk lắk", "dak lak", "daklak"]),
  E("angiang", ["an giang"]),
  E("kiengiang", ["kiên giang", "kien giang"]),
  E("camau", ["cà mau", "ca mau"]),
  E("binhduong", ["bình dương", "binh duong"]),
  E("dongnai", ["đồng nai", "dong nai"]),
  E("bariavungtau", ["bà rịa", "vũng tàu", "vung tau", "ba ria"]),
  E("bacninh", ["bắc ninh", "bac ninh"]),
  E("phuquoc", ["phú quốc", "phu quoc"]),
  E("quangtri", ["quảng trị", "quang tri"]),
  E("khanhhoa", ["khánh hòa", "khanh hoa"]),
  E("lamdong", ["lâm đồng", "lam dong"]),
  E("mientrung", ["miền trung", "mien trung", "central vietnam"]),
  E("mienbac", [
    "miền bắc",
    "mien bac",
    "northern vietnam",
    "bắc bộ",
    "bac bo",
  ]),
  E("miennam", [
    "miền nam",
    "mien nam",
    "southern vietnam",
    "nam bộ",
    "nam bo",
  ]),
  E("taynguyen", ["tây nguyên", "tay nguyen", "central highlands"]),
  E("dbscl", [
    "đồng bằng sông cửu long",
    "dong bang song cuu long",
    "mekong delta",
  ]),
  E("halong", ["hạ long", "ha long"]),

  /* ---- Southeast & East Asia ---- */
  E("china", ["trung quốc", "trung hoa", "china", "bắc kinh", "beijing"]),
  E("japan", ["nhật bản", "japan", "tokyo"]),
  E("southkorea", ["hàn quốc", "han quoc", "south korea", "seoul"]),
  E("northkorea", ["triều tiên", "trieu tien", "north korea", "pyongyang"]),
  E("taiwan", ["đài loan", "dai loan", "taiwan", "taipei", "đài bắc"]),
  E("hongkong", ["hong kong", "hồng kông"]),
  E("thailand", ["thái lan", "thai lan", "thailand", "bangkok"]),
  E("myanmar", ["myanmar", "miến điện", "yangon"]),
  E("laos", ["lào", "laos", "vientiane", "viêng chăn"]),
  E("cambodia", ["campuchia", "cambodia", "phnom penh"]),
  E("malaysia", ["malaysia", "mã lai", "kuala lumpur"]),
  E("singapore", ["singapore"]),
  E("indonesia", ["indonesia", "jakarta"]),
  E("philippines", ["philippines", "manila"]),
  E("india", ["ấn độ", "an do", "india", "new delhi"]),
  E("pakistan", ["pakistan"]),
  E("bangladesh", ["bangladesh"]),
  E(
    "australia",
    ["australia", "australian", "sydney", "canberra"],
    ["(?<!(?:bà|cô|ông|anh|chị|em)\\s+)úc"],
    ["(?<!(?:ba|co|ong|anh|chi|em)\\s+)uc"],
  ),
  E("newzealand", ["new zealand"]),

  /* ---- Middle East ---- */
  E("israel", ["israel", "do thái", "tel aviv", "jerusalem"]),
  E("palestine", ["palestine", "gaza", "dải gaza"]),
  E("iran", ["iran", "tehran"]),
  E("iraq", ["iraq"]),
  E("syria", ["syria", "syri", "damascus"]),
  E("lebanon", ["lebanon", "li băng", "beirut"]),
  E("yemen", ["yemen", "houthi"]),
  E("saudi", [
    "saudi",
    "saudi arabia",
    "ả rập",
    "arab saudi",
    "arap xeut",
    "riyadh",
  ]),
  E("uae", ["uae", "emirates", "dubai", "abu dhabi"]),
  E("qatar", ["qatar", "doha"]),
  E("turkey", [
    "thổ nhĩ kỳ",
    "tho nhi ky",
    "turkey",
    "türkiye",
    "ankara",
    "istanbul",
  ]),

  /* ---- Europe ---- */
  // "nga" collides with the Vietnamese given name Nga — excluded when a
  // personal title/name precedes it ("bà Nga", "cô Nga", "chị Nga").
  E(
    "russia",
    ["russia", "moscow", "matxcơva", "kremlin"],
    [
      "(?<!(?:bà|cô|ông|anh|chị|em|nguyễn|trần|lê|phạm|hoàng|vũ|đặng|bùi|đỗ|phan)\\s+)nga",
    ],
    [
      "(?<!(?:ba|co|ong|anh|chi|em|nguyen|tran|le|pham|hoang|vu|dang|bui|do|phan)\\s+)nga",
    ],
  ),
  E("ukraine", ["ukraine", "ukraina", "kyiv", "kiev"]),
  // bare "anh" is a common Vietnamese word (brother/photo) — never an alias
  E(
    "uk",
    ["anh quốc", "united kingdom", "britain", "london", "nước anh"],
    ["\\buk\\b"],
  ),
  // bare "pháp" collides with "pháp luật/pháp lý/…" — guarded below
  E(
    "france",
    ["france", "paris", "tây ban pháp"],
    [
      "pháp(?!\\s+(?:luật|luat|lý|ly|nhân|nhan|chế|che|định|dinh|sư|su|tán|tan|trường|truong|đoàn|doan|vân|van|học|hoc|ngôn|ngon|y))",
    ],
    ["phap(?!\\s+(?:luat|ly|nhan|che|dinh|su|tan|truong|doan|van|hoc|ngon|y))"],
  ),
  E(
    "germany",
    ["germany", "berlin", "đức quốc", "nước đức"],
    [
      "(?<!(?:bà|cô|ông|anh|chị|em|nguyễn|trần|lê|phạm|hoàng|vũ|đặng|bùi|đỗ|phan)\\s+)đức",
    ],
    [
      "(?<!(?:ba|co|ong|anh|chi|em|nguyen|tran|le|pham|hoang|vu|dang|bui|do|phan)\\s+)duc",
    ],
  ),
  // bare "ý" is a common word (idea/opinion) — never an alias
  E("italy", ["italy", "italia", "rome", "nước ý", "ý quốc"]),
  E("spain", ["tây ban nha", "tay ban nha", "spain", "madrid"]),
  E("poland", ["ba lan", "poland", "warsaw"]),
  E("netherlands", ["hà lan", "ha lan", "netherlands", "amsterdam"]),
  E("belgium", ["belgium", "brussels"], ["bỉ"]),
  E("switzerland", ["thụy sĩ", "thuy si", "switzerland", "geneva", "zurich"]),
  E("sweden", ["thụy điển", "thuy dien", "sweden", "stockholm"]),
  E("norway", ["na uy", "norway", "oslo"]),
  E("denmark", ["đan mạch", "dan mach", "denmark", "copenhagen"]),
  E("finland", ["phần lan", "phan lan", "finland", "helsinki"]),
  // bare "áo" is a common word (shirt) — qualified forms only
  E("austria", ["áo quốc", "nước áo", "austria", "vienna"]),
  E("greece", ["hy lạp", "hy lap", "greece", "athens"]),
  E("portugal", ["bồ đào nha", "bo dao nha", "portugal", "lisbon"]),
  E("ireland", ["ireland", "dublin"]),
  E("hungary", ["hungary", "budapest"]),
  // bare "séc" = cheque — qualified forms only
  E("czech", ["czech", "cộng hòa séc", "cong hoa sec", "prague", "séc quốc"]),
  E("romania", ["romania", "rumania", "bucharest"]),
  E(
    "eu",
    ["european union", "liên minh châu âu", "lien minh chau au"],
    ["\\beu\\b"],
  ),

  /* ---- Americas ---- */
  // bare "mỹ" collides with "mỹ phẩm/mỹ thuật/mỹ nhân…" — guarded below;
  // "nhà trắng" (White House) lives on the raw surface only — normalized
  // "nha trang" is the Khánh Hòa city and wins there.
  E(
    "us",
    [
      "hoa kỳ",
      "hoa ky",
      "united states",
      "usa",
      "u s a",
      "america",
      "washington",
      "white house",
      "nhà trắng",
      "pentagon",
      "lầu năm góc",
      "lau nam goc",
    ],
    [
      "u\\.?s\\.?a?\\b",
      "mỹ(?!\\s+(?:phẩm|pham|thuật|thuat|nhân|nhan|dung|tâm|tam|lực|luc|học|hoc|tính|tinh|cảm|cam|quan|vị|vi|hóa|hoa|thực|thuc|lệ|le|kỳ|ky)\\b)",
    ],
    [
      "u\\.?s\\.?a?\\b",
      "my(?!\\s+(?:pham|thuat|nhan|dung|tam|luc|hoc|tinh|cam|quan|vi|hoa|thuc|le|ky)\\b)",
    ],
  ),
  E("canada", ["canada", "ottawa", "toronto"]),
  E("mexico", ["mexico", "mê hi cô"]),
  E("brazil", ["brazil", "brasil"]),
  E("argentina", ["argentina", "buenos aires"]),
  E("chile", ["chile", "santiago"]),
  E("peru", ["peru", "lima"]),
  E("colombia", ["colombia", "bogota"]),
  E("venezuela", ["venezuela", "caracas"]),
  E("cuba", ["cuba", "havana"]),
  E("panama", ["panama"]),
  E("haiti", ["haiti"]),

  /* ---- Africa & others ---- */
  E("egypt", ["ai cập", "ai cap", "egypt", "cairo"]),
  E("southafrica", ["nam phi", "south africa"]),
  E("nigeria", ["nigeria"]),
  E("kenya", ["kenya", "nairobi"]),
  E("sudan", ["sudan"]),
  E("ethiopia", ["ethiopia"]),
  E("morocco", ["morocco", "ma rốc"]),
  E("libya", ["libya"]),
  E("congo", ["congo"]),
  E("southsudan", ["nam sudan", "south sudan"]),

  /* ---- Supranational & hot regions ---- */
  E("nato", ["nato"]),
  E(
    "un",
    ["liên hợp quốc", "lien hop quoc", "united nations", "lhq"],
    ["\\bun\\b"],
  ),
  E("asean", ["asean"]),
  E("aseancup", ["fifa asean cup", "asean cup", "aff cup"]),
  E("asiad", [
    "asiad",
    "asian games",
    "đại hội thể thao châu á",
    "dai hoi the thao chau a",
  ]),
  E(
    "unga",
    [
      "đại hội đồng liên hợp quốc",
      "dai hoi dong lien hop quoc",
      "un general assembly",
    ],
    ["\\bunga\\b"],
  ),
  E("brics", ["brics", "thượng đỉnh brics"]),
  E("g20", ["g20", "thượng đỉnh g20"]),
  E("middleeast", ["trung đông", "trung dong", "middle east"]),
  E("baltic", ["biển đen", "bien den", "black sea", "baltic"]),
  E("southchinasea", [
    "biển đông",
    "bien dong",
    "south china sea",
    "hoàng sa",
    "hoang sa",
    "trường sa",
    "truong sa",
  ]),
  E("redsea", ["biển đỏ", "bien do", "red sea", "bab al mandab"]),

  /* ---- Institutions (claim subjects too) ---- */
  E(
    "federal_reserve",
    ["federal reserve", "federal reserve board", "fomc"],
    ["\\bfed\\b"],
  ),
  E(
    "nhnn",
    ["ngân hàng nhà nước", "ngan hang nha nuoc"],
    ["\\bnhnn\\b", "\\bsbv\\b"],
  ),
  E("ecb", ["european central bank"], ["\\becb\\b"]),
  E("boj", ["bank of japan"], ["\\bboj\\b"]),
  E("opec", ["opec", "opec+", "tổ chức các nước xuất khẩu dầu"]),
  E("imf", ["quỹ tiền tệ quốc tế"], ["\\bimf\\b"]),
  E("worldbank", ["world bank", "ngân hàng thế giới"]),
  E("wto", [], ["\\bwto\\b"]),
  E("who", ["tổ chức y tế thế giới"], ["\\bwho\\b"]),

  /* ---- High-salience people (hot names only, not NER) ---- */
  E("trump", [
    "trump",
    "donald trump",
    "ông trump",
    "tổng thống mỹ",
    "tong thong my",
  ]),
  E("putin", ["putin", "ông putin", "tổng thống nga"]),
  E("zelensky", ["zelensky", "zelenskyy", "volodymyr zelensky"]),
  E("xijinping", [
    "tập cận bình",
    "tap can binh",
    "xi jinping",
    "ông tập",
    "chủ tịch trung quốc",
    "chu tich trung quoc",
  ]),
  E("hunsen", ["hun sen", "ông hun sen"]),
  E("kimsangsik", ["kim sang-sik", "kim sang sik"]),
  E("kimjongun", ["kim jong", "kim jong-un", "kim jong un"]),
  E("netanyahu", ["netanyahu"]),
  E("modi", ["modi"]),
  E("milei", ["milei"]),
  E("lam", ["tô lâm", "to lam", "tổng bí thư tô lâm"]),
  E("biden", ["biden"]),
  E("macron", ["macron"]),
  E("starmer", ["starmer"]),
  E("vonderleyen", ["von der leyen", "ursula von der leyen"]),
  E("pm", ["lê minh hưng", "thủ tướng", "prime minister", "thu tuong"]),

  /* ---- Companies / tech ----
   * product/brand aliases stay (a "ChatGPT" story is an OpenAI story);
   * person names were split into their own slugs in the audit — a
   * Musk/Altman/Cook mention is a person, never a company mention */
  E("openai", ["openai", "chatgpt"]),
  E("anthropic", ["anthropic", "claude"]),
  E("spacex", ["spacex", "starlink"], ["\\bfalcon\\b"]),
  E("tesla", ["tesla", "tesla inc"]),
  E("meta", ["meta", "facebook"]),
  E("google", ["google", "alphabet", "deepmind"]),
  E("apple", ["apple"], ["\\bapple\\b"]),
  E("microsoft", ["microsoft"]),
  E("nvidia", ["nvidia"]),
  E("bytedance", ["bytedance", "tiktok"]),
  E("vinfast", ["vinfast", "green sm"]),
  /* people split out of company slugs in the audit */
  E("musk", ["elon musk", "ông musk"], ["\\bmusk\\b"]),
  E("zuckerberg", ["zuckerberg", "mark zuckerberg"]),
  E("samaltman", ["sam altman", "altman"]),
  E("amodei", ["dario amodei", "amodei"]),
  E("jensenhuang", ["jensen huang"]),
  E("timcook", ["tim cook"]),
  E("phamnhatvuong", ["phạm nhật vượng", "pham nhat vuong"]),
  E("viettel", ["viettel"]),
  E("samsung", ["samsung"]),
  E("intel", [], ["\\bintel\\b"]),
  E("boeing", ["boeing"]),
  E("airbus", ["airbus"]),

  /* ---- Commodities / recurring story entities (previously cluster-only) ---- */
  E("pipeline", [
    "đường ống",
    "duong ong",
    "pipeline",
    "tuyến ống",
    "tuyen ong",
  ]),
  E("oil", [
    "dầu thô",
    "dau tho",
    "dầu brent",
    "dau brent",
    "brent",
    "xuất khẩu dầu",
    "xuat khau dau",
    "oil",
    "crude oil",
    "wti",
  ]),
  E("drone", [
    "uav",
    "drone",
    "máy bay không người lái",
    "may bay khong nguoi lai",
  ]),
  // bare "ai" = Vietnamese "who" — qualified forms only
  E("ai", [
    "trí tuệ nhân tạo",
    "tri tue nhan tao",
    "artificial intelligence",
    "mô hình ai",
    "mo hinh ai",
    "generative ai",
    "genai",
    "ai model",
  ]),
  E("semiconductor", [
    "bán dẫn",
    "ban dan",
    "semiconductor",
    "chips",
    "vi mạch",
    "vi mach",
  ]),
  E("trade_surplus", [
    "thặng dư thương mại",
    "thang du thuong mai",
    "cán cân thương mại",
    "can can thuong mai",
    "trade surplus",
  ]),
  E("song_hong", [
    "sông hồng",
    "song hong",
    "ven sông hồng",
    "ven song hong",
    "khu tái định cư",
    "khu tai dinh cu",
  ]),
  E("nine_eleven", [
    "khủng bố 11/9",
    "vụ 11/9",
    "thảm kịch 11/9",
    "tưởng niệm 11/9",
    "9/11",
    "september 11",
    "tháp đôi 11/9",
  ]),
];

/* ---------------------------- matcher build ------------------------------ */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bounded = (alts: string[]) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}])`,
    "iu",
  );

/** raw-surface matchers: literal aliases + raw fragments on NFC text */
const RAW_MATCHERS: [RegExp, string][] = GAZETTEER.flatMap((d) => {
  const alts = [...d.aliases.map(esc), ...(d.raw ?? [])].filter(
    (a) => a.length > 0,
  );
  return alts.length ? [[bounded(alts), d.slug]] : [];
});

/** normalized-surface matchers: aliases normalized like the input text.
 *  Global flag so injectEntityTokens rewrites every occurrence. */
const NORM_MATCHERS: [RegExp, string][] = GAZETTEER.flatMap((d) => {
  const alts = [
    ...d.aliases.map((a) => normalizeText(a)).map(esc),
    ...(d.norm ?? d.raw ?? []),
  ].filter((a) => a.length > 0);
  if (!alts.length) return [];
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  return [[re, d.slug]];
});

/**
 * Canonical entity slugs found in raw text. Deterministic and additive —
 * an event's entity signature unions new slugs as evidence accumulates.
 */
export function extractEntities(text: string): string[] {
  // feeds mix composed/decomposed Vietnamese (NFC/NFD) — match on NFC
  const nfc = text.normalize("NFC");
  const found = new Set<string>();
  for (const [re, slug] of RAW_MATCHERS) {
    if (re.test(nfc)) found.add(slug);
  }
  return [...found].sort();
}

/** Sorted space-joined signature for storage on events.entity_signature. */
export function entitySignature(text: string): string {
  return extractEntities(text).join(" ");
}

/** All entity slugs in normalized text (diacritics-stripped input). */
export function extractEntitiesNormalized(normText: string): string[] {
  const found = new Set<string>();
  for (const [re, slug] of NORM_MATCHERS) {
    if (re.test(normText)) found.add(slug);
  }
  return [...found].sort();
}

/**
 * Rewrite matched entity spans inside NORMALIZED text to
 * " entity_<slug> " tokens — the keyword/bigram pipelines downstream
 * then see identity terms shared across vi/en wording.
 */
export function injectEntityTokens(normText: string): string {
  let out = ` ${normText} `;
  for (const [re, slug] of NORM_MATCHERS) {
    out = out.replace(re, ` entity_${slug} `);
  }
  return out.replace(/\s+/g, " ").trim();
}

/* ------------------------- display labels ------------------------- */

/** Curated display names — where the known short form is an acronym
 *  ("federal_reserve" → "FED"), the common Vietnamese name beats the first
 *  English alias ("germany" → "Đức"), or the diacritic-bearing alias would
 *  mislead ("palestine" → "dải gaza" is only part of the story). */
const LABEL_OVERRIDES: Record<string, string> = {
  // institutions — the acronym is the known form
  federal_reserve: "FED",
  nhnn: "NHNN",
  ecb: "ECB",
  boj: "BOJ",
  imf: "IMF",
  worldbank: "Ngân hàng Thế giới",
  wto: "WTO",
  who: "WHO",
  nato: "NATO",
  eu: "EU",
  asean: "ASEAN",
  aseancup: "ASEAN Cup",
  asiad: "ASIAD",
  g20: "G20",
  brics: "BRICS",
  uae: "UAE",
  ai: "AI",
  drone: "UAV",
  // countries — the short Vietnamese name beats the first English alias
  us: "Mỹ",
  uk: "Anh",
  russia: "Nga",
  france: "Pháp",
  germany: "Đức",
  italy: "Ý",
  austria: "Áo",
  belgium: "Bỉ",
  czech: "Séc",
  australia: "Úc",
  saudi: "Ả Rập Xê Út",
  turkey: "Thổ Nhĩ Kỳ",
  morocco: "Ma Rốc",
  // diacritic-alias traps: the vi alias names only part of the entity
  palestine: "Palestine",
  israel: "Israel",
  kimjongun: "Kim Jong-un",
  vonderleyen: "Von der Leyen",
  // vietnamese short forms
  hcmc: "TP.HCM",
  dbscl: "ĐBSCL",
  // recurring story entities — what readers call them
  tesla: "Tesla",
  musk: "Elon Musk",
  zuckerberg: "Mark Zuckerberg",
  samaltman: "Sam Altman",
  amodei: "Dario Amodei",
  jensenhuang: "Jensen Huang",
  timcook: "Tim Cook",
  phamnhatvuong: "Phạm Nhật Vượng",
  pm: "Thủ tướng",
  lam: "Tô Lâm",
  trump: "Donald Trump",
  pipeline: "đường ống dầu",
  oil: "dầu thô",
  semiconductor: "bán dẫn",
  trade_surplus: "thặng dư thương mại",
  song_hong: "sông Hồng",
  nine_eleven: "11/9",
  // brand casing the generic title-case would flatten
  vinfast: "VinFast",
  openai: "OpenAI",
  spacex: "SpaceX",
  bytedance: "ByteDance",
  nvidia: "NVIDIA",
  viettel: "Viettel",
};

const DEFS_BY_SLUG = new Map(GAZETTEER.map((d) => [d.slug, d]));

/** Read-only view of the gazetteer — for audit, seed generation and
 *  runtime resolution. The array itself stays private so matcher
 *  construction remains the only mutable path. */
export function gazetteerEntries(): readonly EntityDef[] {
  return GAZETTEER;
}

/* --------------------- canonical identity registry --------------------- */

/* Canonical entity types — deliberately broader than the UI's 4-way
 * kind, but NOT finance-specific: this is the durable identity layer
 * every domain (news, company intel, macro) shares. A slug is a
 * text-matching token; the canonical_key is the identity. */
export type CanonicalEntityType =
  | "person"
  | "organization"
  | "company"
  | "government_body"
  | "central_bank"
  | "multilateral_organization"
  | "country"
  | "region"
  | "place"
  | "commodity"
  | "topic"
  | "event_series"
  | "brand"
  | "other";

export interface CanonicalEntityRef {
  /** durable identity — `${type}:${short_name}`; the DB maps key→uuid */
  key: string;
  type: CanonicalEntityType;
  /** formal/legal name for the entities table; defaults to the
   *  gazetteer display label when unset */
  name?: string;
  /** flag for human review when slug ≠ clean identity (role-title
   *  aliases, person names inside company slugs, brand/company blur) */
  ambiguity?: string;
}

const CK = (
  type: CanonicalEntityType,
  name: string,
  ambiguity?: string,
  canonicalName?: string,
): CanonicalEntityRef => ({
  key: `${type}:${name}`,
  type,
  ambiguity,
  name: canonicalName,
});

/* Every gazetteer slug maps to exactly one canonical identity. Listing
 * is explicit (not derived) so audits catch silent omissions. */
const CANONICAL: Record<string, CanonicalEntityRef> = {
  /* Vietnam & localities */
  vietnam: CK("country", "vietnam"),
  hanoi: CK("place", "hanoi"),
  hcmc: CK("place", "ho_chi_minh_city"),
  danang: CK("place", "da_nang"),
  haiphong: CK("place", "hai_phong"),
  cantho: CK("place", "can_tho"),
  hue: CK("place", "hue"),
  nhatrang: CK("place", "nha_trang"),
  dalat: CK("place", "da_lat"),
  quangninh: CK("place", "quang_ninh"),
  hatinh: CK("place", "ha_tinh"),
  nghean: CK("place", "nghe_an"),
  thanhhoa: CK("place", "thanh_hoa"),
  laocai: CK("place", "lao_cai"),
  langson: CK("place", "lang_son"),
  caobang: CK("place", "cao_bang"),
  dienbien: CK("place", "dien_bien"),
  sonla: CK("place", "son_la"),
  gialai: CK("place", "gia_lai"),
  daklak: CK("place", "dak_lak"),
  angiang: CK("place", "an_giang"),
  kiengiang: CK("place", "kien_giang"),
  camau: CK("place", "ca_mau"),
  binhduong: CK("place", "binh_duong"),
  dongnai: CK("place", "dong_nai"),
  bariavungtau: CK("place", "ba_ria_vung_tau"),
  bacninh: CK("place", "bac_ninh"),
  phuquoc: CK("place", "phu_quoc"),
  quangtri: CK("place", "quang_tri"),
  khanhhoa: CK("place", "khanh_hoa"),
  lamdong: CK("place", "lam_dong"),
  mientrung: CK("region", "central_vietnam"),
  mienbac: CK("region", "northern_vietnam"),
  miennam: CK("region", "southern_vietnam"),
  taynguyen: CK("region", "central_highlands"),
  dbscl: CK("region", "mekong_delta"),
  halong: CK("place", "ha_long"),

  /* Asia-Pacific countries */
  china: CK("country", "china"),
  japan: CK("country", "japan"),
  southkorea: CK("country", "south_korea"),
  northkorea: CK("country", "north_korea"),
  taiwan: CK("country", "taiwan"),
  hongkong: CK("place", "hong_kong"),
  thailand: CK("country", "thailand"),
  myanmar: CK("country", "myanmar"),
  laos: CK("country", "laos"),
  cambodia: CK("country", "cambodia"),
  malaysia: CK("country", "malaysia"),
  singapore: CK("country", "singapore"),
  indonesia: CK("country", "indonesia"),
  philippines: CK("country", "philippines"),
  india: CK("country", "india"),
  pakistan: CK("country", "pakistan"),
  bangladesh: CK("country", "bangladesh"),
  australia: CK("country", "australia"),
  newzealand: CK("country", "new_zealand"),

  /* Middle East */
  israel: CK("country", "israel"),
  palestine: CK(
    "country",
    "palestine",
    "state recognition disputed; aliases reach into Gaza",
  ),
  iran: CK("country", "iran"),
  iraq: CK("country", "iraq"),
  syria: CK("country", "syria"),
  lebanon: CK("country", "lebanon"),
  yemen: CK("country", "yemen", "'houthi' alias is a faction, not the state"),
  saudi: CK("country", "saudi_arabia"),
  uae: CK("country", "united_arab_emirates"),
  qatar: CK("country", "qatar"),
  turkey: CK("country", "turkey"),

  /* Europe */
  russia: CK("country", "russia"),
  ukraine: CK("country", "ukraine"),
  uk: CK("country", "united_kingdom"),
  france: CK("country", "france"),
  germany: CK("country", "germany"),
  italy: CK("country", "italy"),
  spain: CK("country", "spain"),
  poland: CK("country", "poland"),
  netherlands: CK("country", "netherlands"),
  belgium: CK("country", "belgium"),
  switzerland: CK("country", "switzerland"),
  sweden: CK("country", "sweden"),
  norway: CK("country", "norway"),
  denmark: CK("country", "denmark"),
  finland: CK("country", "finland"),
  austria: CK("country", "austria"),
  greece: CK("country", "greece"),
  portugal: CK("country", "portugal"),
  ireland: CK("country", "ireland"),
  hungary: CK("country", "hungary"),
  czech: CK("country", "czechia"),
  romania: CK("country", "romania"),
  eu: CK("multilateral_organization", "european_union"),

  /* Americas */
  us: CK("country", "us"),
  canada: CK("country", "canada"),
  mexico: CK("country", "mexico"),
  brazil: CK("country", "brazil"),
  argentina: CK("country", "argentina"),
  chile: CK("country", "chile"),
  peru: CK("country", "peru"),
  colombia: CK("country", "colombia"),
  venezuela: CK("country", "venezuela"),
  cuba: CK("country", "cuba"),
  panama: CK("country", "panama"),
  haiti: CK("country", "haiti"),

  /* Africa */
  egypt: CK("country", "egypt"),
  southafrica: CK("country", "south_africa"),
  nigeria: CK("country", "nigeria"),
  kenya: CK("country", "kenya"),
  sudan: CK("country", "sudan"),
  ethiopia: CK("country", "ethiopia"),
  morocco: CK("country", "morocco"),
  libya: CK("country", "libya"),
  congo: CK("country", "congo"),
  southsudan: CK("country", "south_sudan"),

  /* Supranational & recurring forums */
  nato: CK("multilateral_organization", "nato"),
  un: CK("multilateral_organization", "united_nations"),
  asean: CK("multilateral_organization", "asean"),
  aseancup: CK(
    "event_series",
    "asean_cup",
    "a sports competition, not the ASEAN body",
  ),
  asiad: CK(
    "event_series",
    "asiad",
    "recurring games; each edition is a distinct sub-story",
  ),
  unga: CK(
    "event_series",
    "un_general_assembly",
    "annual session, not the UN organ itself",
  ),
  brics: CK("multilateral_organization", "brics"),
  g20: CK("multilateral_organization", "g20"),

  /* Hot regions */
  middleeast: CK("region", "middle_east"),
  baltic: CK(
    "region",
    "black_sea",
    "label says Baltic but aliases are Black Sea — name mismatch",
  ),
  southchinasea: CK("region", "south_china_sea"),
  redsea: CK("region", "red_sea"),

  /* Institutions */
  federal_reserve: CK("central_bank", "fed", undefined, "Federal Reserve"),
  nhnn: CK("central_bank", "sbv", undefined, "Ngân hàng Nhà nước Việt Nam"),
  ecb: CK("central_bank", "ecb", undefined, "European Central Bank"),
  boj: CK("central_bank", "boj", undefined, "Bank of Japan"),
  opec: CK("multilateral_organization", "opec"),
  imf: CK(
    "multilateral_organization",
    "imf",
    undefined,
    "International Monetary Fund",
  ),
  worldbank: CK(
    "multilateral_organization",
    "world_bank",
    undefined,
    "World Bank",
  ),
  wto: CK(
    "multilateral_organization",
    "wto",
    undefined,
    "World Trade Organization",
  ),
  who: CK(
    "multilateral_organization",
    "who",
    undefined,
    "World Health Organization",
  ),

  /* People */
  trump: CK(
    "person",
    "donald_trump",
    "'tổng thống mỹ' alias is a role title — temporally bound",
  ),
  putin: CK(
    "person",
    "vladimir_putin",
    "'tổng thống nga' alias is a role title",
  ),
  zelensky: CK("person", "volodymyr_zelensky"),
  xijinping: CK("person", "xi_jinping"),
  hunsen: CK("person", "hun_sen"),
  kimsangsik: CK("person", "kim_sang_sik"),
  kimjongun: CK("person", "kim_jong_un"),
  netanyahu: CK("person", "benjamin_netanyahu"),
  modi: CK("person", "narendra_modi"),
  milei: CK("person", "javier_milei"),
  lam: CK("person", "to_lam"),
  biden: CK("person", "joe_biden"),
  macron: CK("person", "emmanuel_macron"),
  starmer: CK("person", "keir_starmer"),
  vonderleyen: CK("person", "ursula_von_der_leyen"),
  pm: CK(
    "government_body",
    "prime_minister_office",
    "role/office, not a person — 'lê minh hưng' alias binds the current holder",
  ),

  /* Companies — product/brand aliases intentionally stay (a "ChatGPT"
   * story is an OpenAI story); person names were split to person slugs
   * in the audit. Canonical = the legal entity where it's the named
   * actor (Alphabet for 'google', Meta Platforms for 'meta'). */
  openai: CK(
    "company",
    "openai",
    "'chatgpt' is a product brand alias",
    "OpenAI, Inc.",
  ),
  anthropic: CK(
    "company",
    "anthropic",
    "'claude' is a product brand alias",
    "Anthropic PBC",
  ),
  spacex: CK(
    "company",
    "spacex",
    "'starlink'/'falcon' are product brand aliases",
    "SpaceX",
  ),
  tesla: CK("company", "tesla", undefined, "Tesla, Inc."),
  meta: CK(
    "company",
    "meta_platforms",
    "'facebook' is a brand of the company",
    "Meta Platforms, Inc.",
  ),
  google: CK(
    "company",
    "alphabet",
    "canonical = Alphabet Inc.; 'Google' is its brand",
    "Alphabet Inc.",
  ),
  apple: CK("company", "apple", undefined, "Apple Inc."),
  microsoft: CK("company", "microsoft"),
  nvidia: CK("company", "nvidia"),
  bytedance: CK("company", "bytedance", "'tiktok' is a product brand alias"),
  vinfast: CK(
    "company",
    "vinfast",
    "'green sm' is the separate GSM brand, kept as alias for coverage",
  ),
  /* people split out of company slugs in the audit */
  musk: CK("person", "elon_musk"),
  zuckerberg: CK("person", "mark_zuckerberg"),
  samaltman: CK("person", "sam_altman"),
  amodei: CK("person", "dario_amodei"),
  jensenhuang: CK("person", "jensen_huang"),
  timcook: CK("person", "tim_cook"),
  phamnhatvuong: CK("person", "pham_nhat_vuong"),
  viettel: CK("company", "viettel"),
  samsung: CK(
    "company",
    "samsung_electronics",
    undefined,
    "Samsung Electronics",
  ),
  intel: CK("company", "intel", undefined, "Intel Corporation"),
  boeing: CK("company", "boeing", undefined, "The Boeing Company"),
  airbus: CK("company", "airbus", undefined, "Airbus SE"),

  /* Commodities / recurring story anchors */
  pipeline: CK("topic", "oil_pipeline"),
  oil: CK("commodity", "crude_oil"),
  drone: CK("topic", "uav"),
  ai: CK("topic", "artificial_intelligence"),
  semiconductor: CK("topic", "semiconductor_industry"),
  trade_surplus: CK("topic", "trade_balance"),
  song_hong: CK("place", "red_river", "a river treated as a story anchor"),
  nine_eleven: CK(
    "topic",
    "september_11_attacks",
    "a historical event, kept as a topic anchor",
  ),
};

/** Canonical identity for a gazetteer slug; null for unknown slugs. */
export function canonicalEntity(slug: string): CanonicalEntityRef | null {
  const bare = slug.startsWith("entity_") ? slug.slice(7) : slug;
  return CANONICAL[bare] ?? null;
}

/** Canonical key string for resolution (`country:us`, `company:nvidia`). */
export function canonicalKeyForSlug(slug: string): string | null {
  return canonicalEntity(slug)?.key ?? null;
}

/* ------------------------- entity kinds ------------------------- */

export type EntityKind = "place" | "org" | "person" | "topic";

/* Kinds are the UI's coarse roll-up of the canonical types — one
 * direction only, so the four-value taxonomy stays stable while the
 * canonical layer can grow finer types. */
export const KIND_OF_TYPE: Record<CanonicalEntityType, EntityKind> = {
  person: "person",
  organization: "org",
  company: "org",
  government_body: "org",
  central_bank: "org",
  multilateral_organization: "org",
  brand: "org",
  country: "place",
  region: "place",
  place: "place",
  commodity: "topic",
  topic: "topic",
  event_series: "topic",
  other: "topic",
};

/** Coarse UI kind of a gazetteer slug, derived from the canonical
 *  type; null for slugs outside the gazetteer. */
export function entityKind(slug: string): EntityKind | null {
  const bare = slug.startsWith("entity_") ? slug.slice(7) : slug;
  if (!DEFS_BY_SLUG.has(bare)) return null;
  const canon = CANONICAL[bare];
  return canon ? KIND_OF_TYPE[canon.type] : "topic";
}

/** Kind of a canonical type string straight from the DB — null for
 *  types outside the V1 vocabulary rather than a wrong guess. */
export function kindOfType(type: string | null | undefined): EntityKind | null {
  return type && type in KIND_OF_TYPE
    ? KIND_OF_TYPE[type as CanonicalEntityType]
    : null;
}

/** Vietnamese label for a kind — badge text on entity chips/pages. */
export function entityKindLabel(kind: EntityKind): string {
  switch (kind) {
    case "place":
      return "Địa điểm";
    case "org":
      return "Tổ chức";
    case "person":
      return "Nhân vật";
    case "topic":
      return "Chủ đề";
  }
}

/** Vietnamese label for a canonical entity_type — finer-grained badge
 *  text than the four-value kind rollup on identity-aware surfaces. */
export function entityTypeLabel(type: string): string {
  switch (type) {
    case "person":
      return "Nhân vật";
    case "company":
      return "Công ty";
    case "brand":
      return "Thương hiệu";
    case "organization":
      return "Tổ chức";
    case "government_body":
      return "Cơ quan nhà nước";
    case "central_bank":
      return "Ngân hàng trung ương";
    case "multilateral_organization":
      return "Tổ chức đa phương";
    case "country":
      return "Quốc gia";
    case "region":
      return "Khu vực";
    case "place":
      return "Địa điểm";
    case "commodity":
      return "Hàng hóa";
    case "event_series":
      return "Chuỗi sự kiện";
    case "topic":
      return "Chủ đề";
    default:
      return "Thực thể";
  }
}

/** Vietnamese label for an entity_relationships type. Direction is
 *  the caller's concern — 'in' reads "X is described BY this edge". */
export function entityRelationshipLabel(type: string): string {
  switch (type) {
    case "parent_of":
      return "công ty mẹ của";
    case "subsidiary_of":
      return "công ty con của";
    case "owns":
      return "sở hữu";
    case "owned_by":
      return "thuộc sở hữu của";
    case "operates":
      return "vận hành";
    case "regulated_by":
      return "chịu sự quản lý của";
    case "member_of":
      return "thành viên của";
    case "part_of":
      return "một phần của";
    case "headquartered_in":
      return "trụ sở tại";
    case "located_in":
      return "nằm tại";
    case "led_by":
      return "do lãnh đạo";
    case "brand_of":
      return "thương hiệu của";
    case "successor_of":
      return "kế nhiệm";
    case "predecessor_of":
      return "tiền nhiệm của";
    default:
      return "liên quan tới";
  }
}

const VI_MARK =
  /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

function viTitleCase(s: string): string {
  // gazetteer aliases are overwhelmingly proper nouns — Vietnamese name
  // convention capitalizes every syllable ("hà nội" → "Hà Nội")
  return s.replace(
    /(^|\s)(\p{L})/gu,
    (_m, sp: string, ch: string) => sp + ch.toUpperCase(),
  );
}

/** Human-readable label for a canonical slug — "entity_" prefixes and
 *  unknown slugs degrade gracefully instead of leaking raw tokens to UI. */
export function entityLabel(slug: string): string {
  const bare = slug.startsWith("entity_") ? slug.slice(7) : slug;
  const override = LABEL_OVERRIDES[bare];
  if (override) return override;
  const def = DEFS_BY_SLUG.get(bare);
  if (def) {
    // the diacritic-bearing alias is usually the canonical vi form
    const alias = def.aliases.find((a) => VI_MARK.test(a)) ?? def.aliases[0];
    if (alias) return viTitleCase(alias);
  }
  return viTitleCase(bare.replace(/_/g, " "));
}
