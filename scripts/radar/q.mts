import { getPool } from "../../lib/db/pool.ts";
const db = getPool();
const st = await db.query(
  "SELECT cv.state, COUNT(*) FROM claim_versions cv JOIN claims c ON c.current_version_id = cv.id GROUP BY 1 ORDER BY 2 DESC",
);
console.log("claim states:", st.rows);
const sk = await db.query("SELECT kind, COUNT(*) FROM sources GROUP BY 1");
console.log("source kinds:", sk.rows);
await db.end();
