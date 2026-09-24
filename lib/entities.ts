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
  E("federal_reserve", ["federal reserve", "fomc"], ["\\bfed\\b"]),
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

  /* ---- Companies / tech ---- */
  E("openai", ["openai", "chatgpt", "sam altman"]),
  E("anthropic", ["anthropic", "claude", "dario amodei", "amodei"]),
  E("spacex", ["spacex", "starlink"], ["\\bfalcon\\b"]),
  E("tesla", ["tesla", "elon musk"], ["\\bmusk\\b"]),
  E("meta", ["facebook", "zuckerberg"], ["\\bmeta\\b"]),
  E("google", ["google", "alphabet", "deepmind"]),
  E("apple", ["tim cook"], ["\\bapple\\b"]),
  E("microsoft", ["microsoft"]),
  E("nvidia", ["nvidia", "jensen huang"]),
  E("bytedance", ["bytedance", "tiktok"]),
  E("vinfast", ["vinfast", "phạm nhật vượng", "pham nhat vuong", "green sm"]),
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
