import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { orderAuditLogs, orderJobs, orderRows } from "../../../db/schema";
import { actorText, getRequestActor } from "./actor";

type IncomingRow = {
  lineNo: number;
  sourceSystem: string;
  orderId: string;
  category: string;
  productName: string;
  quantity: string;
  expectedPrice: string;
  customerName: string;
  recipientName: string;
  recipientPhone: string;
  zipcode: string;
  address: string;
  addressDetail: string;
  memo: string;
  status: "READY" | "HOLD" | "FAILED";
  reason: string;
};

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "저장소가 아직 준비되지 않았습니다. 사이트 배포 과정에서 데이터베이스가 생성됩니다.";
  }
  return message;
}

export async function GET() {
  try {
    const db = getDb();
    const jobs = await db
      .select()
      .from(orderJobs)
      .orderBy(desc(orderJobs.createdAt), desc(orderJobs.id))
      .limit(50);
    return Response.json({ jobs });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const actor = getRequestActor(request);
    const payload = (await request.json()) as {
      filename?: string;
      rows?: IncomingRow[];
    };
    const filename = payload.filename?.trim() || "orders.xlsx";
    const rows = payload.rows ?? [];
    const sourceSystem = rows.find((row) => row.sourceSystem)?.sourceSystem || "미지정";

    if (!Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: "저장할 주문 행이 없습니다." }, { status: 400 });
    }

    const totalRows = rows.length;
    const readyRows = rows.filter((row) => row.status === "READY").length;
    const holdRows = rows.filter((row) => row.status === "HOLD").length;
    const failedRows = rows.filter((row) => row.status === "FAILED").length;
    const status = failedRows > 0 ? "FAILED" : holdRows > 0 ? "HOLD" : "READY";
    const db = getDb();

    const [job] = await db
      .insert(orderJobs)
      .values({
        filename,
        sourceSystem,
        status,
        totalRows,
        readyRows,
        holdRows,
        failedRows,
        createdByName: actor.name,
        createdByEmail: actor.email,
        updatedByName: actor.name,
        updatedByEmail: actor.email,
      })
      .returning();

    await db.insert(orderRows).values(
      rows.map((row) => ({
        jobId: job.id,
        lineNo: row.lineNo,
        orderId: row.orderId,
        category: row.category,
        productName: row.productName,
        quantity: row.quantity,
        expectedPrice: row.expectedPrice,
        customerName: row.customerName,
        recipientName: row.recipientName,
        recipientPhone: row.recipientPhone,
        zipcode: row.zipcode,
        address: row.address,
        addressDetail: row.addressDetail,
        memo: row.memo,
        status: row.status,
        reason: row.reason,
      })),
    );

    await db
      .update(orderJobs)
      .set({ updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(orderJobs.id, job.id));

    await db.insert(orderAuditLogs).values({
      jobId: job.id,
      action: "ORDER_CREATED",
      actorName: actor.name,
      actorEmail: actor.email,
      detail: `${actorText(actor)}님이 ${filename} 주문 ${totalRows}건을 접수했습니다.`,
    });

    return Response.json(
      {
        job: {
          ...job,
          status,
          totalRows,
          readyRows,
          holdRows,
          failedRows,
          createdByName: actor.name,
          createdByEmail: actor.email,
          updatedByName: actor.name,
          updatedByEmail: actor.email,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
