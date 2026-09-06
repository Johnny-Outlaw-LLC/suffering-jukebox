import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser } from "@/lib/sj-admin-auth";
import { rateLimited, tooMany, bad } from "@/lib/jukebox-request";
import {
  COLUMNS,
  DATASET_FILE,
  DATASET_LABEL,
  DATASET_NOTE,
  csvLine,
  exportRows,
  isDataset,
  type Row,
} from "@/lib/my-data-export";

export const dynamic = "force-dynamic";
// A full listening history is tens of thousands of rows read a page at a time.
export const maxDuration = 60;

/* The response is streamed rather than assembled, because a whole listening
   history is comfortably larger than a buffered function response may be.
   The CSV carries no provenance line: a comment above the header would open
   in a spreadsheet as a stray first row and push every column out of line.
   JSON, which nothing renders directly, carries it as a field. */
function buildStream(rows: AsyncGenerator<Row>, columns: string[], format: "csv" | "json", note: string) {
  const encoder = new TextEncoder();
  let started = false;
  let wroteRow = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(encoder.encode(format === "csv"
            ? csvLine(columns)
            : `{"export":${JSON.stringify(note)},"columns":${JSON.stringify(columns)},"rows":[`));
          return;
        }
        const next = await rows.next();
        if (next.done) {
          if (format === "json") controller.enqueue(encoder.encode("]}\n"));
          controller.close();
          return;
        }
        if (format === "csv") {
          controller.enqueue(encoder.encode(csvLine(next.value)));
        } else {
          const object: Record<string, unknown> = {};
          columns.forEach((column, index) => { object[column] = next.value[index] ?? null; });
          controller.enqueue(encoder.encode((wroteRow ? "," : "") + JSON.stringify(object)));
          wroteRow = true;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() { await rows.return(undefined as never); },
  });
}

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser(req);
    if (!user?.email) return bad("Sign in to download your data.", 401);
    if (rateLimited(`my-data-export:${user.id}`, 20, 60_000)) return tooMany();

    const body = await req.json().catch(() => ({}));
    const dataset = body?.dataset;
    if (!isDataset(dataset)) return bad("Choose which of your data to download.");
    const format: "csv" | "json" = body?.format === "json" ? "json" : "csv";

    const sb = createSjServiceClient();
    const rows = exportRows(sb, dataset, { id: user.id, email: user.email });
    const columns = COLUMNS[dataset];
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `suffering-jukebox-${DATASET_FILE[dataset]}-${stamp}.${format}`;
    const note = `${DATASET_LABEL[dataset]} — ${DATASET_NOTE[dataset]} Downloaded ${new Date().toISOString()}.`;

    return new NextResponse(buildStream(rows, columns, format, note), {
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        // The browser fetches this with an Authorization header, so the file is
        // saved by script and the name has to reach it somewhere readable.
        "Access-Control-Expose-Headers": "X-Sj-Filename",
        "X-Sj-Filename": fileName,
      },
    });
  } catch (error) {
    console.error("[my-data:export]", error);
    return bad("Could not build that download.", 502);
  }
}
