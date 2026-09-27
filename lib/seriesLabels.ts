/* Shared display labels for macro series — used by the /macro board
 * (server) and the changes rail (client). Canonical identity stays the
 * series_code; these are presentation only — a wrong label never
 * corrupts data. */

export type MacroGroup =
  | "vietnam"
  | "growth"
  | "inflation"
  | "labour"
  | "rates"
  | "money"
  | "markets"
  | "fx"
  | "asia"
  | "world";

export const SERIES_VI: Record<string, { g: MacroGroup; vi: string }> = {
  GDPC1: { g: "growth", vi: "GDP thực (quý)" },
  INDPRO: { g: "growth", vi: "Sản xuất công nghiệp" },
  RSAFS: { g: "growth", vi: "Bán lẻ & dịch vụ ăn uống" },
  HOUST: { g: "growth", vi: "Khởi công nhà ở mới" },
  CPIAUCSL: { g: "inflation", vi: "CPI tiêu dùng (index)" },
  PCEPILFE: { g: "inflation", vi: "Core PCE — thước đo Fed ưa" },
  UMCSENT: { g: "inflation", vi: "Tâm lý người tiêu dùng (U.Mich)" },
  UNRATE: { g: "labour", vi: "Tỷ lệ thất nghiệp" },
  PAYEMS: { g: "labour", vi: "Việc làm phi nông nghiệp" },
  FEDFUNDS: { g: "rates", vi: "Fed Funds Rate" },
  DGS2: { g: "rates", vi: "Trái phiếu Kho bạc 2Y" },
  DGS10: { g: "rates", vi: "Trái phiếu Kho bạc 10Y" },
  T10Y2Y: { g: "rates", vi: "Độ dốc đường cong 10Y−2Y" },
  T10YIE: { g: "rates", vi: "Lạm phát kỳ vọng 10Y (breakeven)" },
  MORTGAGE30US: { g: "rates", vi: "Lãi vay mua nhà 30Y" },
  M2SL: { g: "money", vi: "Cung tiền M2" },
  WALCL: { g: "money", vi: "Bảng cân đối Fed (tài sản)" },
  SP500: { g: "markets", vi: "S&P 500" },
  VIXCLS: { g: "markets", vi: "VIX — biến động kỳ vọng" },
  BAMLH0A0HYM2: { g: "markets", vi: "Spread trái phiếu high-yield" },
  DCOILWTICO: { g: "markets", vi: "Dầu WTI ($/thùng)" },
  DTWEXBGS: { g: "fx", vi: "Chỉ số đô la (broad)" },
  DEXUSEU: { g: "fx", vi: "USD/EUR" },
  DEXJPUS: { g: "fx", vi: "JPY/USD" },
  DEXCHUS: { g: "fx", vi: "CNY/USD" },
  ECBDFR: { g: "world", vi: "Lãi suất ECB (deposit)" },
  FPCPITOTLZGCHN: { g: "world", vi: "CPI Trung Quốc (năm)" },
  FPCPITOTLZGJPN: { g: "world", vi: "CPI Nhật Bản (năm)" },
  FPCPITOTLZGDEU: { g: "world", vi: "CPI Đức (năm)" },
  FPCPITOTLZGGBR: { g: "world", vi: "CPI Anh (năm)" },
};

const WB_VI: Record<string, string> = {
  "NY.GDP.MKTP.CD": "GDP (US$ hiện tại)",
  "NY.GDP.MKTP.KD.ZG": "GDP tăng trưởng (%/năm)",
  "FP.CPI.TOTL.ZG": "Lạm phát CPI (%)",
  "SL.UEM.TOTL.ZS": "Thất nghiệp (%)",
  "NE.EXP.GNFS.ZS": "Xuất khẩu (% GDP)",
  "BX.KLT.DINV.WD.GD.ZS": "FDI ròng vào (% GDP)",
  "SP.POP.TOTL": "Dân số",
};
const WB_COUNTRY_VI: Record<string, string> = {
  VNM: "Việt Nam",
  THA: "Thái Lan",
  IDN: "Indonesia",
  MYS: "Malaysia",
  PHL: "Philippines",
  KHM: "Campuchia",
  LAO: "Lào",
  MMR: "Myanmar",
  IND: "Ấn Độ",
  CHN: "Trung Quốc",
  KOR: "Hàn Quốc",
  JPN: "Nhật Bản",
  SGP: "Singapore",
};

/** series_code → display meta; World Bank `ISO3:IND` codes resolve by
 * pattern, FRED codes by the SERIES_VI map. */
export function seriesMeta(code: string): { g: MacroGroup; vi: string } | null {
  const direct = SERIES_VI[code];
  if (direct) return direct;
  const i = code.indexOf(":");
  if (i < 0) return null;
  const cc = code.slice(0, i);
  const vi = WB_VI[code.slice(i + 1)];
  const cn = WB_COUNTRY_VI[cc];
  if (!vi || !cn) return null;
  return { g: cc === "VNM" ? "vietnam" : "asia", vi: `${cn} — ${vi}` };
}
