// 브라우저와 서버가 같은 순서로 승인 대상 행을 직렬화한다. 고객정보를 저장하거나 출력하지 않는다.
export function submissionContent(job) {
  const fields = ["lineNo", "sourceSystem", "orderId", "productName", "option", "quantity", "expectedPrice",
    "recipientName", "recipientPhone", "zipcode", "address", "addressDetail", "memo", "destination",
    "주문번호", "납품처", "납품처전화번호", "품명", "주문수량", "비고(내역)"];
  return JSON.stringify([String(job.sourceSystem ?? ""), String(job.filename ?? job.sourceFile ?? ""), String(job.sourceDate ?? ""),
    (job.rows ?? []).map((row) => [...fields, "sourceFile", "sourceDate"].map((key) => String(row[key] ?? "")))]);
}
