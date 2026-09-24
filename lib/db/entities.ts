/**
 * Lightweight entity extraction for the event resolver.
 * Gazetteer-only in V0.2 — deterministic canonical slugs, vi+en aliases
 * collapse to one identity ("Hoa Kỳ"/"Mỹ"/"US" → "us"). A proper
 * entities/aliases table lands in P1; this module is the seam.
 *
 * Purpose is NOT full NER — it is the contradiction guard: two events
 * naming different places must never merge on a shared generic claim
 * ("deaths" of a Japan typhoon vs an Indonesia earthquake).
 */

const A = (slug: string, ...aliases: string[]): [RegExp, string] => [
  // Unicode-aware boundaries — JS \b is ASCII-only, so aliases ending in
  // diacritics ("mỹ", "đài loan") would never match. Lookarounds treat
  // any letter/number as a word char.
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${aliases.join("|")})(?![\\p{L}\\p{N}])`,
    "iu",
  ),
  slug,
];

/*
 * Canonical slugs. Diacritics-insensitive matching relies on the 'u'
 * flag plus pre-normalized text (callers pass normalizeText output OR
 * raw text — patterns cover the common diacritic spellings).
 */
const GAZETTEER: [RegExp, string][] = [
  /* ---- Vietnam & major localities ---- */
  A("vietnam", "việt nam", "vietnam", "viet nam", "vietnamese"),
  A("hanoi", "hà nội", "ha noi", "hanoi"),
  A("hcmc", "tp\\.? ?hcm", "hồ chí minh", "ho chi minh", "sài gòn", "sai gon"),
  A("danang", "đà nẵng", "da nang", "danang"),
  A("haiphong", "hải phòng", "hai phong", "haiphong"),
  A("cantho", "cần thơ", "can tho"),
  A("hue", "huế", "hue"),
  A("nhatrang", "nha trang"),
  A("dalat", "đà lạt", "da lat"),
  A("quangninh", "quảng ninh", "quang ninh"),
  A("hatinh", "hà tĩnh", "ha tinh"),
  A("nghean", "nghệ an", "nghe an"),
  A("thanhhoa", "thanh hóa", "thanh hoa"),
  A("laocai", "lào cai", "lao cai"),
  A("langson", "lạng sơn", "lang son"),
  A("caobang", "cao bằng", "cao bang"),
  A("dienbien", "điện biên", "dien bien"),
  A("sonla", "sơn la", "son la"),
  A("gialai", "gia lai"),
  A("daklak", "đắk lắk", "dak lak", "daklak"),
  A("angiang", "an giang"),
  A("kiengiang", "kiên giang", "kien giang"),
  A("camau", "cà mau", "ca mau"),
  A("binhduong", "bình dương", "binh duong"),
  A("dongnai", "đồng nai", "dong nai"),
  A("bariavungtau", "bà rịa", "vũng tàu", "vung tau", "ba ria"),
  A("bacninh", "bắc ninh", "bac ninh"),
  A("phuquoc", "phú quốc", "phu quoc"),

  /* ---- Southeast & East Asia ---- */
  A("china", "trung quốc", "trung hoa", "china", "bắc kinh", "beijing"),
  A("japan", "nhật bản", "nhật", "japan", "tokyo"),
  A("southkorea", "hàn quốc", "han quoc", "south korea", "seoul"),
  A("northkorea", "triều tiên", "trieu tien", "north korea", "pyongyang"),
  A("taiwan", "đài loan", "dai loan", "taiwan", "taipei", "đài bắc"),
  A("hongkong", "hong kong", "hồng kông"),
  A("thailand", "thái lan", "thai lan", "thailand", "bangkok"),
  A("myanmar", "myanmar", "miến điện", "yangon"),
  A("laos", "lào", "laos", "vientiane", "viêng chăn"),
  A("cambodia", "campuchia", "cambodia", "phnom penh"),
  A("malaysia", "malaysia", "mã lai", "kuala lumpur"),
  A("singapore", "singapore"),
  A("indonesia", "indonesia", "jakarta"),
  A("philippines", "philippines", "manila"),
  A("india", "ấn độ", "an do", "india", "new delhi"),
  A("pakistan", "pakistan"),
  A("bangladesh", "bangladesh"),
  A("australia", "úc", "australia", "australian", "sydney", "canberra"),
  A("newzealand", "new zealand"),

  /* ---- Middle East ---- */
  A("israel", "israel", "do thái", "tel aviv", "jerusalem"),
  A("palestine", "palestine", "gaza", "dải gaza"),
  A("iran", "iran", "tehran"),
  A("iraq", "iraq"),
  A("syria", "syria", "syri", "damascus"),
  A("lebanon", "lebanon", "li băng", "beirut"),
  A("yemen", "yemen", "houthi"),
  A("saudi", "saudi", "ả rập", "riyadh"),
  A("uae", "uae", "emirates", "dubai", "abu dhabi"),
  A("qatar", "qatar", "doha"),
  A(
    "turkey",
    "thổ nhĩ kỳ",
    "tho nhi ky",
    "turkey",
    "türkiye",
    "ankara",
    "istanbul",
  ),

  /* ---- Europe ---- */
  A("russia", "nga", "russia", "moscow", "matxcơva", "kremlin"),
  A("ukraine", "ukraine", "ukraina", "kyiv", "kiev"),
  A("uk", "anh quốc", "anh", "united kingdom", "britain", "london", "uk"),
  A("france", "pháp", "france", "paris"),
  A("germany", "đức", "germany", "berlin"),
  A("italy", "ý", "italy", "italia", "rome"),
  A("spain", "tây ban nha", "tay ban nha", "spain", "madrid"),
  A("poland", "ba lan", "poland", "warsaw"),
  A("netherlands", "hà lan", "ha lan", "netherlands", "amsterdam"),
  A("belgium", "bỉ", "belgium", "brussels"),
  A("switzerland", "thụy sĩ", "thuy si", "switzerland", "geneva", "zurich"),
  A("sweden", "thụy điển", "thuy dien", "sweden", "stockholm"),
  A("norway", "na uy", "norway", "oslo"),
  A("denmark", "đan mạch", "dan mach", "denmark", "copenhagen"),
  A("finland", "phần lan", "phan lan", "finland", "helsinki"),
  A("austria", "áo", "austria", "vienna"),
  A("greece", "hy lạp", "hy lap", "greece", "athens"),
  A("portugal", "bồ đào nha", "bo dao nha", "portugal", "lisbon"),
  A("ireland", "ireland", "dublin"),
  A("hungary", "hungary", "budapest"),
  A("czech", "czech", "séc", "prague"),
  A("romania", "romania", "rumania", "bucharest"),
  A(
    "eu",
    "european union",
    "liên minh châu âu",
    "lien minh chau au",
    "\\beu\\b",
  ),

  /* ---- Americas ---- */
  A(
    "us",
    "hoa kỳ",
    "hoa ky",
    "mỹ",
    "mĩ",
    "united states",
    "u\\.?s\\.?a?\\b",
    "america",
    "washington",
    "white house",
    "nhà trắng",
  ),
  A("canada", "canada", "ottawa", "toronto"),
  A("mexico", "mexico", "mê hi cô"),
  A("brazil", "brazil", "brasil"),
  A("argentina", "argentina", "buenos aires"),
  A("chile", "chile", "santiago"),
  A("peru", "peru", "lima"),
  A("colombia", "colombia", "bogota"),
  A("venezuela", "venezuela", "caracas"),
  A("cuba", "cuba", "havana"),
  A("panama", "panama"),
  A("haiti", "haiti"),

  /* ---- Africa & others ---- */
  A("egypt", "ai cập", "ai cap", "egypt", "cairo"),
  A("southafrica", "nam phi", "south africa"),
  A("nigeria", "nigeria"),
  A("kenya", "kenya", "nairobi"),
  A("sudan", "sudan"),
  A("ethiopia", "ethiopia"),
  A("morocco", "morocco", "ma rốc"),
  A("libya", "libya"),
  A("congo", "congo"),
  A("southsudan", "nam sudan", "south sudan"),

  /* ---- Supranational & hot regions ---- */
  A("nato", "nato"),
  A(
    "un",
    "liên hợp quốc",
    "lien hop quoc",
    "united nations",
    "\\bun\\b",
    "lhq",
  ),
  A("asean", "asean"),
  A("aseancup", "fifa asean cup", "asean cup", "aff cup"),
  A(
    "asiad",
    "asiad",
    "asian games",
    "đại hội thể thao châu á",
    "dai hoi the thao chau a",
  ),
  A(
    "unga",
    "đại hội đồng liên hợp quốc",
    "dai hoi dong lien hop quoc",
    "un general assembly",
    "\\bunga\\b",
  ),
  A("brics", "brics"),
  A("middleeast", "trung đông", "trung dong", "middle east"),
  A("baltic", "biển đen", "bien den", "black sea", "baltic"),
  A(
    "southchinasea",
    "biển đông",
    "bien dong",
    "south china sea",
    "hoàng sa",
    "hoang sa",
    "trường sa",
    "truong sa",
  ),

  /* ---- Vietnam places (added: resolver needs local entity context) ---- */
  A("quangtri", "quảng trị", "quang tri"),
  A("khanhhoa", "khánh hòa", "khanh hoa"),
  A("lamdong", "lâm đồng", "lam dong"),
  A("mientrung", "miền trung", "mien trung", "central vietnam"),
  A("mienbac", "miền bắc", "mien bac", "northern vietnam", "bắc bộ", "bac bo"),
  A("miennam", "miền nam", "mien nam", "southern vietnam", "nam bộ", "nam bo"),
  A("taynguyen", "tây nguyên", "tay nguyen", "central highlands"),
  A(
    "dbscl",
    "đồng bằng sông cửu long",
    "dong bang song cuu long",
    "mekong delta",
  ),
  A("halong", "hạ long", "ha long"),

  /* ---- Institutions (claim subjects too) ---- */
  A("federal_reserve", "federal reserve", "\\bfed\\b", "fomc"),
  A(
    "nhnn",
    "ngân hàng nhà nước",
    "ngan hang nha nuoc",
    "\\bnhnn\\b",
    "\\bsbv\\b",
  ),
  A("ecb", "\\becb\\b", "european central bank"),
  A("boj", "\\bboj\\b", "bank of japan"),
  A("opec", "opec\\+?", "tổ chức các nước xuất khẩu dầu"),
  A("imf", "\\bimf\\b", "quỹ tiền tệ quốc tế"),
  A("worldbank", "world bank", "ngân hàng thế giới"),
  A("wto", "\\bwto\\b"),
  A("who", "\\bwho\\b", "tổ chức y tế thế giới"),

  /* ---- High-salience people (hot names only, not NER) ---- */
  A(
    "trump",
    "trump",
    "donald trump",
    "ông trump",
    "tổng thống mỹ",
    "tong thong my",
  ),
  A("putin", "putin", "ông putin"),
  A("zelensky", "zelensky", "zelenskyy"),
  A(
    "xijinping",
    "tập cận bình",
    "tap can binh",
    "xi jinping",
    "ông tập",
    "chủ tịch trung quốc",
    "chu tich trung quoc",
  ),
  A("hunsen", "hun sen", "ông hun sen"),
  A("kimsangsik", "kim sang-sik", "kim sang sik"),
  A("kimjongun", "kim jong", "kim jong-un", "kim jong un"),
  A("netanyahu", "netanyahu"),
  A("modi", "modi"),
  A("milei", "milei"),
  A("lam", "tô lâm", "to lam", "tổng bí thư tô lâm"),
  A("biden", "biden"),
  A("macron", "macron"),
  A("starmer", "starmer"),
  A("vonderleyen", "von der leyen", "ursula von der leyen"),
  A("openai", "openai", "chatgpt", "sam altman"),
  A("spacex", "spacex", "\\bfalcon\\b", "\\bstarlink\\b"),
  A("tesla", "tesla", "elon musk", "\\bmusk\\b"),
  A("meta", "\\bmeta\\b", "facebook", "zuckerberg"),
  A("google", "google", "alphabet", "deepmind"),
  A("apple", "\\bapple\\b", "tim cook"),
  A("microsoft", "microsoft"),
  A("nvidia", "nvidia", "jensen huang"),
  A("bytedance", "bytedance", "tiktok"),
  A("vinfast", "vinfast"),
  A("viettel", "viettel"),
  A("samsung", "samsung"),
  A("intel", "\\bintel\\b"),
  A("boeing", "boeing"),
  A("airbus", "airbus"),
];

/**
 * Canonical entity slugs found in text. Deterministic and additive —
 * an event's entity signature unions new slugs as evidence accumulates.
 */
export function extractEntities(text: string): string[] {
  // feeds mix composed/decomposed Vietnamese (NFC/NFD) — match on NFC
  const nfc = text.normalize("NFC");
  const found = new Set<string>();
  for (const [re, slug] of GAZETTEER) {
    if (re.test(nfc)) found.add(slug);
  }
  return [...found].sort();
}

/** Sorted space-joined signature for storage on events.entity_signature. */
export function entitySignature(text: string): string {
  return extractEntities(text).join(" ");
}
