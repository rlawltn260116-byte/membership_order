"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Database,
  Download,
  FileWarning,
  FileSpreadsheet,
  History,
  KeyRound,
  ListChecks,
  Loader2,
  Map as MapIcon,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Settings,
  ShieldCheck,
  Upload,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createOrderJob, getOrderJob, listOrderJobs, updateOrderJob } from "@/lib/firebase-order-ops";

type OrderRow = {
  lineNo: number;
  sourceSystem: string;
  orderId: string;
  category: string;
  productName: string;
  option: string;
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

type Job = {
  id: string;
  filename: string;
  sourceSystem: string;
  status: string;
  totalRows: number;
  readyRows: number;
  holdRows: number;
  failedRows: number;
  createdByName: string;
  createdByEmail: string;
  updatedByName: string;
  updatedByEmail: string;
  createdAt: string;
  updatedAt: string;
  rows?: OrderRow[];
  auditLogs?: AuditLog[] | Record<string, AuditLog>;
  report?: {
    workerId: string;
    startedAt: string;
    finishedAt: string;
    totalRows: number;
    successRows: number;
    failedRows: number;
    holdRows: number;
    reviewState: "WAITING_FOR_DASHBOARD" | "BLOCKED";
    canSubmit: false;
    details: Array<{
      lineNo: number;
      status: "READY" | "FAILED" | "HOLD";
      reason: string;
      productId?: string;
      unitPrice?: number;
      quantity?: number;
      shippingFee?: number;
      totalPrice?: number;
    }>;
  };
  dashboardReview?: {
    state: "WAITING_FOR_DASHBOARD" | "BLOCKED" | "ACCEPTED" | "ON_HOLD";
    required: boolean;
    finalSubmissionApproved: boolean;
    updatedAt: string;
    reviewedByName?: string;
    decision?: "ACCEPTED" | "ON_HOLD";
    note?: string;
  };
  dashboardApproval?: {
    approved: boolean;
    approvedBy: string;
    approvedAt: string;
    scope: "PREPARE" | "SUBMIT";
  };
};

type AuditLog = {
  id: string;
  jobId: string;
  action: string;
  actorName: string;
  actorEmail: string;
  detail: string;
  createdAt: string;
};

type CalendarDay = {
  key: string;
  label: number;
  inMonth: boolean;
  isToday: boolean;
  jobs: Job[];
};

type PageMode =
  | "overview"
  | "orders"
  | "calendar"
  | "channels"
  | "mapping"
  | "exceptions"
  | "runs"
  | "reports"
  | "membership"
  | "settings";

const requiredColumns = [
  "order_id",
  "category",
  "product_name",
  "quantity",
  "customer_name",
  "recipient_name",
  "recipient_phone",
  "address",
];

const sampleCsv =
  "source_system,order_id,category,product_name,quantity,expected_price,customer_name,recipient_name,recipient_phone,zipcode,address,address_detail,memo\n" +
  "이로움,TEST-001,급여판매,Handy,1,108000,우리케어,홍길동,010-0000-0000,12345,서울시 금천구 서부샛길 606,101호,샘플";

const appSections: {
  id: PageMode;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  { id: "overview", label: "통합 현황", description: "전체 주문 흐름", icon: <BarChart3 className="h-4 w-4" /> },
  { id: "orders", label: "주문 접수", description: "파일 업로드와 검증", icon: <ListChecks className="h-4 w-4" /> },
  { id: "calendar", label: "전체 일정", description: "일정과 기록", icon: <CalendarDays className="h-4 w-4" /> },
  { id: "channels", label: "채널/ERP", description: "사이트와 ERP 연결", icon: <Building2 className="h-4 w-4" /> },
  { id: "mapping", label: "상품 매핑", description: "상품명과 코드 정리", icon: <MapIcon className="h-4 w-4" /> },
  { id: "exceptions", label: "예외 처리", description: "실패와 보류 큐", icon: <FileWarning className="h-4 w-4" /> },
  { id: "runs", label: "실행 기록", description: "자동화 실행 로그", icon: <History className="h-4 w-4" /> },
  { id: "reports", label: "리포트", description: "성과와 다운로드", icon: <Database className="h-4 w-4" /> },
  { id: "membership", label: "회원/로그인", description: "가입과 권한", icon: <UserRound className="h-4 w-4" /> },
  { id: "settings", label: "관리자 설정", description: "승인과 기준값", icon: <Settings className="h-4 w-4" /> },
];

const orderChannelGroups = [
  {
    title: "B2B몰 주문",
    description: "온라인몰 주문 접수",
    items: ["이로움", "보필", "나눔에이치엔씨"],
  },
  {
    title: "ERP 주문",
    description: "ERP 전표·주문 처리",
    items: ["세비앙", "에이엠이", "명성실버케어"],
  },
  {
    title: "메일 주문",
    description: "메일 주문서 접수",
    items: ["현대메딕스", "나이스텍", "엠씨텍", "안앤락", "삼주유니콘", "진산메디칼", "코리아케어서프라이", "그레이스케일", "삼원스카이, 건강홈케어"],
  },
  {
    title: "팩스 주문",
    description: "팩스 주문서 접수",
    items: ["유광정밀", "미키코리아", "국제케어"],
  },
] as const;

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function splitCsvLine(line: string) {
  const result: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsv(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error("주문 행이 없습니다.");

  const headers = splitCsvLine(lines[0]).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function cell(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return value == null ? "" : String(value).trim();
}

function validateOrder(raw: Record<string, unknown>, index: number): OrderRow {
  const missing = requiredColumns.filter((column) => !cell(raw, column));
  const reasons: string[] = [];
  if (missing.length) reasons.push(`필수값 누락: ${missing.join(", ")}`);

  const quantity = cell(raw, "quantity");
  const parsedQuantity = Number(quantity);
  if (!quantity || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
    reasons.push("수량 확인 필요");
  }

  const phone = cell(raw, "recipient_phone");
  if (phone && !/\d{2,3}-?\d{3,4}-?\d{4}/.test(phone)) {
    reasons.push("수취인 연락처 형식 확인 필요");
  }

  const address = cell(raw, "address");
  if (address && address.length < 6) reasons.push("배송지 주소가 너무 짧음");

  const category = cell(raw, "category");
  if (
    category &&
    ![
      "급여판매",
      "급여상품(판매)",
      "판매",
      "급여대여",
      "급여상품(대여)",
      "대여",
      "비급여",
      "비급여상품",
    ].includes(category)
  ) {
    reasons.push("상품 구분 확인 필요");
  }

  const expectedPrice = cell(raw, "expected_price");
  if (expectedPrice && !/^[0-9,]+$/.test(expectedPrice.replace(/원/g, ""))) {
    reasons.push("예상가 형식 확인 필요");
  }

  return {
    lineNo: index + 2,
    sourceSystem: cell(raw, "source_system") || cell(raw, "site") || cell(raw, "erp") || "미지정",
    orderId: cell(raw, "order_id"),
    category,
    productName: cell(raw, "product_name"),
    option: cell(raw, "option") || cell(raw, "color") || cell(raw, "색상") || cell(raw, "옵션"),
    quantity,
    expectedPrice,
    customerName: cell(raw, "customer_name"),
    recipientName: cell(raw, "recipient_name"),
    recipientPhone: phone,
    zipcode: cell(raw, "zipcode"),
    address,
    addressDetail: cell(raw, "address_detail"),
    memo: cell(raw, "memo"),
    status: reasons.length ? "FAILED" : "READY",
    reason: reasons.join("; "),
  };
}

function statusLabel(status: string) {
  if (status === "READY") return "검증 완료";
  if (status === "HOLD") return "보류";
  if (status === "FAILED") return "실패";
  if (status === "QUEUED") return "실행 대기";
  if (status === "RUNNING") return "서버 처리 중";
  if (status === "AWAITING_REVIEW") return "운영자 검토 대기";
  if (status === "REVIEWED") return "검토 완료";
  if (status === "SUBMIT_QUEUED") return "최종 제출 대기";
  if (status === "COMPLETED") return "완료";
  return status;
}

function statusClass(status: string) {
  if (status === "READY") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (["HOLD", "QUEUED", "RUNNING", "AWAITING_REVIEW", "SUBMIT_QUEUED"].includes(status)) return "border-amber-200 bg-amber-50 text-amber-700";
  if (["REVIEWED", "COMPLETED"].includes(status)) return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "FAILED") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function workerLabel(job: Job) {
  return job.updatedByName || job.createdByName || "로그 없음";
}

function downloadCsv(rows: OrderRow[], filename: string) {
  const headers = [
    "line_no",
    "source_system",
    "order_id",
    "status",
    "reason",
    "category",
    "product_name",
    "option",
    "quantity",
    "expected_price",
    "customer_name",
    "recipient_name",
    "recipient_phone",
    "zipcode",
    "address",
    "address_detail",
    "memo",
  ];
  const body = rows.map((row) =>
    [
      row.lineNo,
      row.sourceSystem,
      row.orderId,
      row.status,
      row.reason,
      row.category,
      row.productName,
      row.option,
      row.quantity,
      row.expectedPrice,
      row.customerName,
      row.recipientName,
      row.recipientPhone,
      row.zipcode,
      row.address,
      row.addressDetail,
      row.memo,
    ]
      .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
      .join(","),
  );
  const blob = new Blob([`\uFEFF${headers.join(",")}\n${body.join("\n")}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/\.[^.]+$/, "") + "_report.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function downloadSample() {
  const blob = new Blob([`\uFEFF${sampleCsv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "eroumcare_order_sample.csv";
  link.click();
  URL.revokeObjectURL(url);
}

const channelPlans = [
  { name: "이로움", type: "B2B몰", status: "연결 준비", rule: "급여/비급여 상품 검색, 장바구니 전 승인" },
  { name: "케어맥스", type: "B2B몰", status: "대기", rule: "상품코드 우선 매칭, 품절 시 보류" },
  { name: "Amaranth ERP", type: "ERP", status: "대기", rule: "거래처/품목/창고 코드 검증 후 전표 생성" },
  { name: "수기 발주", type: "내부", status: "운영", rule: "CSV 업로드 후 담당자 승인" },
];

const mappingExamples = [
  { source: "Handy", canonical: "성인용보행기 Handy", code: "M06091147601", status: "확정" },
  { source: "APT-106", canonical: "목욕의자 APT-106", code: "미등록", status: "확인 필요" },
  { source: "안심버선", canonical: "미끄럼방지양말 안심버선", code: "M0303", status: "후보 2개" },
];

const runSteps = [
  "파일 접수",
  "필수값 검증",
  "상품/거래처 매핑",
  "사이트별 재고·가격 확인",
  "장바구니 또는 ERP 입력",
  "사용자 승인",
  "주문번호/전표번호 수집",
  "리포트 발행",
];

const membershipRoles = [
  { role: "최고 관리자", scope: "전체 채널, 회원 승인, 실행 정책 변경", users: "1명", risk: "모든 변경 감사 기록" },
  { role: "주문 운영자", scope: "주문 업로드, 검증, 보류 처리", users: "3명", risk: "주문 확정 승인 불가" },
  { role: "승인 담당자", scope: "주문 확정, ERP 전표 등록 승인", users: "2명", risk: "본인 업로드 건 승인 제한" },
  { role: "조회 전용", scope: "일정, 실행 기록, 리포트 열람", users: "5명", risk: "다운로드 권한 별도 부여" },
];

const authRoadmap = [
  { title: "1단계", text: "현재처럼 사이트는 비공개로 두고, 회원/역할 정책을 먼저 정리합니다." },
  { title: "2단계", text: "초대 기반 회원가입, 이메일 인증, 관리자 승인 대기 화면을 붙입니다." },
  { title: "3단계", text: "주문 실행, 리포트 다운로드, 채널 설정 같은 위험 작업을 역할별로 차단합니다." },
  { title: "4단계", text: "로그인 실패, 세션 만료, 권한 변경, 주문 승인 이력을 감사 로그로 남깁니다." },
];

const pendingMembers = [
  { name: "김민지", email: "minji@example.com", request: "주문 운영자", status: "승인 대기" },
  { name: "박준호", email: "junho@example.com", request: "조회 전용", status: "추가 확인" },
  { name: "ERP 담당", email: "erp@example.com", request: "승인 담당자", status: "승인 대기" },
];

const adminCards = [
  { title: "회원 승인", text: "신규 가입, 초대 요청, 휴면 해제 요청을 승인하거나 반려합니다." },
  { title: "권한 변경", text: "업로드, 보류 수정, 실행 승인, 리포트 다운로드 권한을 역할별로 관리합니다." },
  { title: "채널 설정", text: "B2B몰과 ERP의 로그인 방식, 주문 단계, 승인 전 멈춤 지점을 정합니다." },
  { title: "상품 매핑", text: "원본 상품명, 표준 상품명, ERP 품목코드, 가격 허용 범위를 관리합니다." },
  { title: "승인 정책", text: "주문 확정, 결제, ERP 전표 등록처럼 외부 변경이 생기는 작업의 승인 단계를 관리합니다." },
  { title: "감사 로그", text: "누가 설정을 바꿨는지, 누가 주문을 처리했는지 장부처럼 남깁니다." },
];

const approvalPolicies = [
  { step: "CSV/엑셀 업로드", owner: "주문 운영자", approval: "불필요", log: "접수자 기록" },
  { step: "보류 사유 수정", owner: "주문 운영자", approval: "불필요", log: "수정자 기록" },
  { step: "B2B몰 장바구니 입력", owner: "승인 담당자", approval: "필요", log: "승인자 기록" },
  { step: "주문 확정/결제", owner: "최고 관리자", approval: "필수", log: "승인자와 처리자 기록" },
  { step: "ERP 전표 등록", owner: "승인 담당자", approval: "필수", log: "전표번호와 처리자 기록" },
];

function toDateKey(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildCalendarDays(monthDate: Date, jobs: Job[]) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const todayKey = toDateKey(new Date());
  const jobsByDate = new Map<string, Job[]>();
  jobs.forEach((job) => {
    const key = toDateKey(job.createdAt);
    if (!key) return;
    jobsByDate.set(key, [...(jobsByDate.get(key) ?? []), job]);
  });

  return Array.from({ length: 42 }, (_, index): CalendarDay => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = toDateKey(date);
    return {
      key,
      label: date.getDate(),
      inMonth: date.getMonth() === monthDate.getMonth(),
      isToday: key === todayKey,
      jobs: jobsByDate.get(key) ?? [],
    };
  });
}

function OverviewPage({ jobs, onGo }: { jobs: Job[]; onGo: (mode: PageMode) => void }) {
  const queued = jobs.filter((job) => job.status === "QUEUED").length;
  const failed = jobs.filter((job) => job.status === "FAILED").length;
  const ready = jobs.filter((job) => job.status === "READY").length;
  const channels = new Set(jobs.map((job) => job.sourceSystem || "미지정")).size;

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">주문 운영 허브</h2>
            <p className="mt-1 text-sm text-slate-600">
              사이트별 주문과 ERP 입력을 같은 흐름으로 접수, 검증, 실행, 기록합니다.
            </p>
          </div>
          <Button onClick={() => onGo("orders")}>
            <Upload className="h-4 w-4" />
            새 주문 접수
          </Button>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-4">
          <OverviewCard label="연결 채널" value={channels || channelPlans.length} />
          <OverviewCard label="검증 완료 작업" value={ready} />
          <OverviewCard label="실행 대기" value={queued} />
          <OverviewCard label="실패 포함" value={failed} />
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          <FlowCard title="접수" text="CSV·엑셀·ERP 내보내기 파일을 같은 주문 스키마로 정규화합니다." />
          <FlowCard title="검증" text="거래처, 상품, 수량, 주소, 예상가, 채널별 필수값을 먼저 확인합니다." />
          <FlowCard title="실행" text="사이트 자동입력 또는 ERP 전표 생성은 승인 전 대기 상태로 분리합니다." />
          <FlowCard title="기록" text="작업자, 주문번호, 전표번호, 실패 사유, 보류 사유를 작업별로 남깁니다." />
        </div>
      </div>

      <aside className="space-y-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="font-semibold">필요 화면</h3>
          <div className="mt-3 space-y-2">
            {appSections.slice(1).map((section) => (
              <button
                key={section.id}
                className="flex w-full items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:border-[#0f766e] hover:bg-teal-50"
                onClick={() => onGo(section.id)}
              >
                <span>
                  <span className="block text-sm font-medium">{section.label}</span>
                  <span className="text-xs text-slate-500">{section.description}</span>
                </span>
                {section.icon}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-[#fff8e6] p-4 text-sm leading-6 text-slate-700">
          실제 주문 확정, 결제, 전표 등록처럼 외부 상태가 바뀌는 단계는 항상 승인 정책을 거쳐야 합니다.
        </div>
      </aside>
    </section>
  );
}

function OrderChannelSidebar({ onSelect }: { onSelect: (channel: string) => void }) {
  return (
    <aside className="h-fit rounded-lg border border-slate-200 bg-white p-3 lg:sticky lg:top-4">
      <div className="border-b border-slate-200 px-2 pb-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#0f766e]">주문 채널</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">거래처를 선택해 이 페이지에서 주문을 접수합니다.</p>
      </div>
      <div className="mt-3 space-y-4">
        {orderChannelGroups.map((group) => (
          <section key={group.title}>
            <div className="px-2">
              <h3 className="text-sm font-semibold text-slate-900">{group.title}</h3>
              <p className="mt-0.5 text-[11px] text-slate-500">{group.description}</p>
            </div>
            <div className="mt-1.5 space-y-0.5">
              {group.items.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-slate-600 transition hover:bg-teal-50 hover:text-[#0f4f49]"
                  onClick={() => onSelect(item)}
                >
                  <span className="mr-2 h-1.5 w-1.5 rounded-full bg-slate-300" />
                  <span className="truncate">{item}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}

function OverviewCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <span className="text-sm text-slate-600">{label}</span>
      <strong className="mt-2 block text-2xl">{value.toLocaleString()}</strong>
    </div>
  );
}

function FlowCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
    </div>
  );
}

export default function OrderOpsApp() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [previewRows, setPreviewRows] = useState<OrderRow[]>([]);
  const [filename, setFilename] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedDateKey, setSelectedDateKey] = useState(() => toDateKey(new Date()));
  const [viewMode, setViewMode] = useState<PageMode>("overview");
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);

  const rows = activeJob?.rows ?? previewRows;
  const orderSummary = useMemo(
    () => ({
      total: rows.length,
      ready: rows.filter((row) => row.status === "READY").length,
      hold: rows.filter((row) => row.status === "HOLD").length,
      failed: rows.filter((row) => row.status === "FAILED").length,
    }),
    [rows],
  );
  const globalSummary = useMemo(
    () => ({
      total: jobs.reduce((sum, job) => sum + job.totalRows, 0),
      ready: jobs.reduce((sum, job) => sum + job.readyRows, 0),
      hold: jobs.reduce((sum, job) => sum + job.holdRows, 0),
      failed: jobs.reduce((sum, job) => sum + job.failedRows, 0),
    }),
    [jobs],
  );
  const summary = viewMode === "orders" ? orderSummary : globalSummary;

  async function openJob(id: string) {
    const data = await getOrderJob(id);
    if (!data) {
      setMessage("작업을 불러오지 못했습니다.");
      return;
    }
    setActiveJob(data as Job);
    setPreviewRows([]);
    setFilename(data.filename);
  }

  async function loadJobs(silent = false) {
    if (!silent) setLoading(true);
    try {
      const data = await listOrderJobs();
      const refreshedJobs = data as Job[];
      setJobs(refreshedJobs);
      if (activeJob) {
        const refreshedActiveJob = refreshedJobs.find((job) => job.id === activeJob.id);
        if (refreshedActiveJob) setActiveJob(refreshedActiveJob);
      } else if (data[0]) {
        await openJob(String(data[0].id));
      }
    } catch (error) {
      if (!silent) setMessage(error instanceof Error ? error.message : "작업 목록 오류");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function handleFile(file: File) {
    setMessage("");
    setFilename(file.name);
    setActiveJob(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setMessage("현재 온라인 초안은 CSV 업로드를 먼저 지원합니다. 엑셀은 CSV로 저장해서 올려주세요.");
      return;
    }
    const rawRows = parseCsv(await file.text());
    const parsed = rawRows.map(validateOrder);
    setPreviewRows(parsed);
    setMessage(`${parsed.length}건을 읽었습니다. 저장하면 다른 PC에서도 이어서 볼 수 있습니다.`);
  }

  async function saveJob() {
    if (!previewRows.length || !filename) return;
    setLoading(true);
    try {
      const now = new Date().toISOString();
      const readyRows = previewRows.filter((row) => row.status === "READY").length;
      const holdRows = previewRows.filter((row) => row.status === "HOLD").length;
      const failedRows = previewRows.filter((row) => row.status === "FAILED").length;
      const job = await createOrderJob({
        filename,
        sourceSystem: previewRows[0]?.sourceSystem || "미지정",
        status: failedRows ? "FAILED" : holdRows ? "HOLD" : "READY",
        totalRows: previewRows.length,
        readyRows,
        holdRows,
        failedRows,
        createdByName: "주문 운영자",
        createdByEmail: "",
        updatedByName: "주문 운영자",
        updatedByEmail: "",
        createdAt: now,
        updatedAt: now,
        rows: previewRows,
        auditLogs: [{ id: `${Date.now()}-created`, jobId: "", action: "ORDER_CREATED", actorName: "주문 운영자", actorEmail: "", detail: `${filename} 주문 ${previewRows.length}건 접수`, createdAt: now }],
      });
      setMessage("클라우드 작업으로 저장했습니다.");
      setPreviewRows([]);
      await loadJobs();
      await openJob(String(job.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "저장 오류");
    } finally {
      setLoading(false);
    }
  }

  async function queueExecution() {
    if (!activeJob) return;
    setLoading(true);
    try {
      await updateOrderJob(activeJob.id, { status: "QUEUED", updatedAt: new Date().toISOString() });
      setMessage("서버 준비 요청을 등록했습니다. 준비 결과는 이 페이지의 검토 탭에서 확인합니다.");
      await loadJobs();
      await openJob(activeJob.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "상태 변경 오류");
    } finally {
      setLoading(false);
    }
  }

  async function reviewWorkerResult(decision: "ACCEPTED" | "ON_HOLD", note = "") {
    if (!activeJob?.report) return;
    setLoading(true);
    const reviewedAt = new Date().toISOString();
    try {
      await updateOrderJob(activeJob.id, {
        status: decision === "ACCEPTED" ? "REVIEWED" : "HOLD",
        dashboardReview: {
          state: decision,
          required: false,
          finalSubmissionApproved: false,
          updatedAt: reviewedAt,
          reviewedByName: "주문 운영자",
          decision,
          note,
        },
        updatedAt: reviewedAt,
      });
      setMessage(decision === "ACCEPTED" ? "검토 결과를 이 페이지에 수락 기록했습니다. 최종 주문 제출은 별도 승인 단계입니다." : "검토 결과를 보류로 기록했습니다.");
      await loadJobs();
      await openJob(activeJob.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "검토 결과 저장 오류");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => void loadJobs(true), 15_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id]);

  const currentTitle = activeJob ? activeJob.filename : filename || "새 주문 파일";

  return (
    <main className="min-h-screen bg-[#f6f7f4] text-slate-950">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-slate-200 pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#0f766e] text-white">
              <ClipboardList className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Membership 주문 운영</h1>
              <p className="text-sm text-slate-600">B2B몰, ERP, 수기 주문을 한 곳에서 접수하고 검증합니다.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void loadJobs()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              새로고침
            </Button>
            <Button onClick={() => inputRef.current?.click()}>
              <Upload className="h-4 w-4" />
              주문 CSV 업로드
            </Button>
            <input
              ref={inputRef}
              className="hidden"
              type="file"
              accept=".csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.currentTarget.value = "";
              }}
            />
          </div>
        </header>

        <div className="grid items-start gap-5 lg:grid-cols-[270px_minmax(0,1fr)]">
          <OrderChannelSidebar
            onSelect={(channel) => {
              setSelectedChannel(channel);
              setViewMode("orders");
              setMessage(`${channel}을 선택했습니다. 주문 준비 요청과 결과 확인은 이 페이지에서 진행합니다.`);
            }}
          />
          <div className="min-w-0 space-y-5">
            <section className="grid gap-3 md:grid-cols-4">
              <MetricCard icon={<FileSpreadsheet />} label="전체 주문" value={summary.total} />
              <MetricCard icon={<CheckCircle2 />} label="검증 완료" value={summary.ready} tone="ready" />
              <MetricCard icon={<PauseCircle />} label="확인 필요" value={summary.hold} tone="hold" />
              <MetricCard icon={<AlertCircle />} label="실패" value={summary.failed} tone="failed" />
            </section>

        <nav className="grid gap-2 rounded-lg border border-slate-200 bg-white p-2 md:grid-cols-3 xl:grid-cols-5">
          {appSections.map((section) => (
            <button
              key={section.id}
              className={`rounded-md border px-3 py-3 text-left transition ${
                viewMode === section.id
                  ? "border-[#0f766e] bg-teal-50 text-[#0f4f49]"
                  : "border-transparent hover:border-slate-200 hover:bg-slate-50"
              }`}
              onClick={() => setViewMode(section.id)}
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                {section.icon}
                {section.label}
              </span>
              <span className="mt-1 block text-xs text-slate-500">{section.description}</span>
            </button>
          ))}
        </nav>

        {viewMode === "overview" ? (
          <OverviewPage jobs={jobs} onGo={setViewMode} />
        ) : viewMode === "calendar" ? (
          <OperationsCalendar
            jobs={jobs}
            monthDate={calendarMonth}
            selectedDateKey={selectedDateKey}
            onMonthChange={setCalendarMonth}
            onSelectedDateChange={setSelectedDateKey}
            onOpenJob={(id) => {
              setViewMode("orders");
              void openJob(id);
            }}
          />
        ) : viewMode === "orders" ? (
          <section className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 p-4">
              <h2 className="font-semibold">클라우드 작업</h2>
              <p className="mt-1 text-sm text-slate-600">저장된 작업은 다른 PC에서도 이어서 볼 수 있습니다.</p>
            </div>
            <div className="max-h-[640px] overflow-auto p-2">
              {jobs.length === 0 ? (
                <div className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">
                  아직 저장된 주문 작업이 없습니다.
                </div>
              ) : (
                jobs.map((job) => (
                  <button
                    key={job.id}
                    className={`mb-2 w-full rounded-md border p-3 text-left transition ${
                      activeJob?.id === job.id
                        ? "border-[#0f766e] bg-teal-50"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                    onClick={() => void openJob(job.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="line-clamp-2 text-sm font-medium">{job.filename}</span>
                      <Badge className={statusClass(job.status)}>{statusLabel(job.status)}</Badge>
                    </div>
                    <div className="mt-2 text-xs text-slate-500">
                      {job.sourceSystem || "미지정"} · {job.totalRows}건 · 완료 {job.readyRows} · 실패 {job.failedRows}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">최근 작업자: {workerLabel(job)}</div>
                  </button>
                ))
              )}
            </div>
            </aside>

            <section className="rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{selectedChannel ? `${selectedChannel} · ${currentTitle}` : currentTitle}</h2>
                  {activeJob ? (
                    <Badge className={statusClass(activeJob.status)}>{statusLabel(activeJob.status)}</Badge>
                  ) : previewRows.length ? (
                    <Badge className="border-sky-200 bg-sky-50 text-sky-700">저장 전 미리보기</Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  서버 처리 결과 확인과 수락·보류는 이 페이지에서 진행합니다. 최종 주문 제출은 별도 승인 단계입니다.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => downloadCsv(rows, currentTitle)} disabled={!rows.length}>
                  <Download className="h-4 w-4" />
                  리포트 다운로드
                </Button>
                {!activeJob && previewRows.length ? (
                  <Button onClick={() => void saveJob()} disabled={loading}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    클라우드 저장
                  </Button>
                ) : (
                  <Button onClick={() => void queueExecution()} disabled={!activeJob || activeJob.status === "QUEUED" || loading}>
                    <PlayCircle className="h-4 w-4" />
                    서버 준비 요청
                  </Button>
                )}
              </div>
            </div>

            {message ? <div className="border-b border-slate-200 bg-[#fff8e6] px-4 py-3 text-sm text-slate-800">{message}</div> : null}

            <Tabs defaultValue="rows" className="p-4">
              <TabsList>
                <TabsTrigger value="rows">주문 행</TabsTrigger>
                <TabsTrigger value="review">서버 결과 검토</TabsTrigger>
                <TabsTrigger value="policy">실행 정책</TabsTrigger>
                <TabsTrigger value="audit">작업 로그</TabsTrigger>
              </TabsList>
              <TabsContent value="rows" className="mt-4">
                {rows.length ? <OrderTable rows={rows} /> : <EmptyState />}
              </TabsContent>
              <TabsContent value="review" className="mt-4">
                <WorkerReviewPanel job={activeJob} loading={loading} onDecision={(decision) => void reviewWorkerResult(decision)} />
              </TabsContent>
              <TabsContent value="policy" className="mt-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <PolicyCard title="검증" text="필수값, 수량, 연락처, 주소, 상품 구분, 예상가 형식을 먼저 확인합니다." />
                  <PolicyCard title="승인" text="검증 완료 건만 실행 대기 상태로 넘깁니다. 실패·보류 행은 리포트에 남습니다." />
                  <PolicyCard title="제출" text="이로움 로그인, 장바구니 추가, 주문 확정은 별도 실행 에이전트와 사용자 승인 후 처리합니다." />
                </div>
              </TabsContent>
              <TabsContent value="audit" className="mt-4">
                <AuditLogPanel job={activeJob} />
              </TabsContent>
            </Tabs>
            </section>
          </section>
        ) : viewMode === "channels" ? (
          <ChannelsPage />
        ) : viewMode === "mapping" ? (
          <MappingPage />
        ) : viewMode === "exceptions" ? (
          <ExceptionsPage
            jobs={jobs}
            onOpenJob={(id) => {
              setViewMode("orders");
              void openJob(id);
            }}
          />
        ) : viewMode === "runs" ? (
          <RunsPage />
        ) : viewMode === "reports" ? (
          <ReportsPage jobs={jobs} />
        ) : viewMode === "membership" ? (
          <MembershipPage />
        ) : (
          <SettingsPage />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function AuditLogPanel({ job }: { job: Job | null }) {
  if (!job) {
    return (
      <EmptyPanel
        title="저장 후 로그가 남습니다"
        text="주문 파일을 클라우드에 저장하면 접수자, 처리자, 상태 변경 이력이 작업 로그로 기록됩니다."
      />
    );
  }

  const logs = Array.isArray(job.auditLogs) ? job.auditLogs : Object.values(job.auditLogs ?? {});

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <h3 className="font-semibold">작업자 요약</h3>
        <div className="mt-3 space-y-3 text-sm">
          <WorkerSummary label="접수자" name={job.createdByName} email={job.createdByEmail} date={job.createdAt} />
          <WorkerSummary label="최근 작업자" name={job.updatedByName} email={job.updatedByEmail} date={job.updatedAt} />
        </div>
      </aside>

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <h3 className="font-semibold">주문 작업 로그</h3>
          <p className="mt-1 text-sm text-slate-600">저장, 상태 변경, 승인, 제출 같은 주문 관련 행동을 시간순으로 남깁니다.</p>
        </div>
        <div className="divide-y divide-slate-200">
          {logs.length ? (
            logs.map((log) => <AuditLogItem key={log.id} log={log} />)
          ) : (
            <p className="p-4 text-sm text-slate-600">아직 기록된 작업 로그가 없습니다.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkerReviewPanel({
  job,
  loading,
  onDecision,
}: {
  job: Job | null;
  loading: boolean;
  onDecision: (decision: "ACCEPTED" | "ON_HOLD") => void;
}) {
  if (!job?.report) {
    return (
      <EmptyPanel
        title="서버 결과가 아직 없습니다"
        text="서버 준비 요청을 등록하면 상품·수량·수취인·배송지와 처리 결과, 예외 사유가 이 화면에 표시됩니다."
      />
    );
  }

  const report = job.report;
  const review = job.dashboardReview;
  const alreadyReviewed = review?.state === "ACCEPTED" || review?.state === "ON_HOLD";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OverviewCard label="총 주문 행" value={report.totalRows} />
        <OverviewCard label="준비 성공" value={report.successRows} />
        <OverviewCard label="실패" value={report.failedRows} />
        <OverviewCard label="보류" value={report.holdRows} />
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">서버 처리 상세</h3>
            <p className="mt-1 text-sm text-slate-600">실행기 {report.workerId} · 시작 {formatDateTime(report.startedAt)} · 종료 {formatDateTime(report.finishedAt)}</p>
            <p className="mt-1 text-sm text-slate-700">
              {report.canSubmit ? "제출 가능" : "서버는 주문을 제출하지 않았습니다. 최종 확정은 운영 페이지의 별도 승인 단계에서 진행합니다."}
            </p>
          </div>
          {alreadyReviewed ? (
            <Badge className={review?.state === "ACCEPTED" ? statusClass("REVIEWED") : statusClass("HOLD")}>
              {review?.state === "ACCEPTED" ? "운영자 수락 완료" : "운영자 보류"}
            </Badge>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onDecision("ON_HOLD")} disabled={loading}>
                보류
              </Button>
              <Button onClick={() => onDecision("ACCEPTED")} disabled={loading || report.holdRows > 0 || report.failedRows > 0}>
                <CheckCircle2 className="h-4 w-4" />
                검토 수락
              </Button>
            </div>
          )}
        </div>
        {report.details.length ? (
          <div className="mt-4 overflow-hidden rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>주문 행</TableHead>
                  <TableHead>결과</TableHead>
                  <TableHead>사유</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.details.map((detail, index) => (
                  <TableRow key={`${detail.lineNo}-${index}`}>
                    <TableCell>{detail.lineNo}</TableCell>
                    <TableCell><Badge className={statusClass(detail.status)}>{statusLabel(detail.status)}</Badge></TableCell>
                    <TableCell className="whitespace-normal">{detail.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-600">행별 예외가 없습니다. 주문 행 탭에서 상품과 배송 정보를 검토하세요.</p>
        )}
        {alreadyReviewed && review ? (
          <p className="mt-3 text-xs text-slate-500">{review.reviewedByName || "주문 운영자"} · {formatDateTime(review.updatedAt)} {review.note ? `· ${review.note}` : ""}</p>
        ) : null}
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-slate-700">
        검토 수락은 서버 준비 결과를 확인했다는 기록입니다. 실제 주문 확정 승인은 이 검토와 구분해 주문 운영 페이지에서 별도로 처리합니다.
      </div>
    </div>
  );
}

function WorkerSummary({
  label,
  name,
  email,
  date,
}: {
  label: string;
  name?: string;
  email?: string;
  date?: string;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      <p className="mt-1 font-medium">{name || "알 수 없음"}</p>
      {email ? <p className="text-xs text-slate-500">{email}</p> : null}
      {date ? <p className="mt-2 text-xs text-slate-500">{formatDateTime(date)}</p> : null}
    </div>
  );
}

function AuditLogItem({ log }: { log: AuditLog }) {
  return (
    <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="border-slate-200 bg-slate-50 text-slate-700">{auditActionLabel(log.action)}</Badge>
          <span className="text-sm font-medium">{log.actorName || "알 수 없음"}</span>
          {log.actorEmail ? <span className="text-xs text-slate-500">{log.actorEmail}</span> : null}
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-700">{log.detail}</p>
      </div>
      <time className="text-xs text-slate-500">{formatDateTime(log.createdAt)}</time>
    </div>
  );
}

function auditActionLabel(action: string) {
  if (action === "ORDER_CREATED") return "주문 접수";
  if (action === "STATUS_CHANGED") return "상태 변경";
  return action;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function OperationsCalendar({
  jobs,
  monthDate,
  selectedDateKey,
  onMonthChange,
  onSelectedDateChange,
  onOpenJob,
}: {
  jobs: Job[];
  monthDate: Date;
  selectedDateKey: string;
  onMonthChange: (date: Date) => void;
  onSelectedDateChange: (dateKey: string) => void;
  onOpenJob: (id: string) => void;
}) {
  const days = useMemo(() => buildCalendarDays(monthDate, jobs), [jobs, monthDate]);
  const monthLabel = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
  }).format(monthDate);
  const monthJobs = jobs.filter((job) => {
    const date = new Date(job.createdAt);
    return date.getFullYear() === monthDate.getFullYear() && date.getMonth() === monthDate.getMonth();
  });
  const queued = monthJobs.filter((job) => job.status === "QUEUED").length;
  const failed = monthJobs.filter((job) => job.status === "FAILED").length;
  const selectedJobs = jobs.filter((job) => toDateKey(job.createdAt) === selectedDateKey);
  const recentJobs = [...jobs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 12);

  function moveMonth(amount: number) {
    onMonthChange(new Date(monthDate.getFullYear(), monthDate.getMonth() + amount, 1));
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-teal-50 text-teal-700">
            <CalendarDays className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-lg font-semibold">전체 일정과 기록</h2>
            <p className="text-sm text-slate-600">업로드, 검증 결과, 실행 대기 상태를 월 단위로 봅니다.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="border-slate-200 bg-slate-50 text-slate-700">{jobs.length}개 작업</Badge>
          <Badge className="border-amber-200 bg-amber-50 text-amber-700">{queued}개 실행 대기</Badge>
          <Badge className="border-rose-200 bg-rose-50 text-rose-700">{failed}개 실패 포함</Badge>
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-slate-200">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h3 className="font-semibold">{monthLabel}</h3>
              <p className="text-sm text-slate-600">날짜를 선택하면 우측에 기록이 펼쳐집니다.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="이전 달" onClick={() => moveMonth(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" onClick={() => onMonthChange(new Date())}>오늘</Button>
            <Button variant="outline" size="icon" aria-label="다음 달" onClick={() => moveMonth(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-medium text-slate-500">
          {["일", "월", "화", "수", "목", "금", "토"].map((day) => (
            <div key={day} className="px-2 py-2">{day}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day) => (
            <button
              key={day.key}
              className={`min-h-[128px] border-b border-r border-slate-200 p-2 text-left last:border-r-0 ${
                day.inMonth ? "bg-white" : "bg-slate-50 text-slate-400"
              } ${selectedDateKey === day.key ? "ring-2 ring-inset ring-[#0f766e]" : ""}`}
              onClick={() => onSelectedDateChange(day.key)}
            >
              <div className="mb-2 flex items-center justify-between">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-sm ${
                    day.isToday ? "bg-[#0f766e] font-semibold text-white" : ""
                  }`}
                >
                  {day.label}
                </span>
                {day.jobs.length ? <span className="text-xs text-slate-500">{day.jobs.length}건</span> : null}
              </div>
              <div className="space-y-1">
                {day.jobs.slice(0, 3).map((job) => (
                  <span
                    key={job.id}
                    className={`block w-full rounded border px-2 py-1 text-xs leading-5 ${statusClass(job.status)}`}
                  >
                    <span className="block truncate font-medium">{job.filename}</span>
                    <span>{job.totalRows}건 · {statusLabel(job.status)}</span>
                  </span>
                ))}
                {day.jobs.length > 3 ? (
                  <div className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">
                    +{day.jobs.length - 3}건 더 있음
                  </div>
                ) : null}
              </div>
            </button>
          ))}
        </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h3 className="font-semibold">월간 현황</h3>
            <div className="mt-4 grid gap-3">
              <CalendarStat label="저장 작업" value={monthJobs.length} />
              <CalendarStat label="실행 대기" value={queued} />
              <CalendarStat label="실패 포함" value={failed} />
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="font-semibold">{selectedDateKey || "선택 날짜"} 기록</h3>
            <div className="mt-3 space-y-2">
              {selectedJobs.length ? (
                selectedJobs.map((job) => (
                  <CalendarRecord key={job.id} job={job} onOpenJob={onOpenJob} />
                ))
              ) : (
                <p className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-600">
                  이 날짜에 저장된 주문 작업이 없습니다.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="font-semibold">최근 기록</h3>
            <div className="mt-3 max-h-[360px] space-y-2 overflow-auto">
              {recentJobs.length ? (
                recentJobs.map((job) => (
                  <CalendarRecord key={job.id} job={job} onOpenJob={onOpenJob} compact />
                ))
              ) : (
                <p className="text-sm text-slate-600">아직 기록이 없습니다.</p>
              )}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function CalendarRecord({
  job,
  onOpenJob,
  compact = false,
}: {
  job: Job;
  onOpenJob: (id: string) => void;
  compact?: boolean;
}) {
  const time = new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(job.createdAt));

  return (
    <button
      className="w-full rounded-md border border-slate-200 bg-slate-50 p-3 text-left hover:border-[#0f766e] hover:bg-teal-50"
      onClick={() => onOpenJob(job.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{job.filename}</span>
          <span className="mt-1 block text-xs text-slate-500">
            {time} · {job.sourceSystem || "미지정"} · {job.totalRows}건 · {workerLabel(job)}
            {!compact ? ` · 완료 ${job.readyRows} · 실패 ${job.failedRows}` : ""}
          </span>
        </span>
        <Badge className={statusClass(job.status)}>{statusLabel(job.status)}</Badge>
      </div>
    </button>
  );
}

function CalendarStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2">
      <span className="text-sm text-slate-600">{label}</span>
      <strong className="text-lg">{value.toLocaleString()}</strong>
    </div>
  );
}

function ChannelsPage() {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <SectionHeader
        icon={<Building2 className="h-5 w-5" />}
        title="채널/ERP 관리"
        text="주문을 받을 사이트와 ERP를 등록하고, 채널별 실행 정책을 관리합니다."
      />
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-hidden rounded-md border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>채널</TableHead>
                <TableHead>유형</TableHead>
                <TableHead>상태</TableHead>
                <TableHead>처리 규칙</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {channelPlans.map((channel) => (
                <TableRow key={channel.name}>
                  <TableCell className="font-medium">{channel.name}</TableCell>
                  <TableCell>{channel.type}</TableCell>
                  <TableCell><Badge className="border-slate-200 bg-slate-50 text-slate-700">{channel.status}</Badge></TableCell>
                  <TableCell className="whitespace-normal">{channel.rule}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <SideNote
          title="채널별로 필요한 설정"
          items={["로그인 방식", "상품 검색 기준", "장바구니/전표 입력 위치", "승인 후 제출 방식", "주문번호 수집 위치"]}
        />
      </div>
    </section>
  );
}

function MappingPage() {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <SectionHeader
        icon={<MapIcon className="h-5 w-5" />}
        title="상품·거래처 매핑"
        text="사이트마다 다른 상품명, ERP 품목코드, 거래처명을 내부 기준으로 맞춥니다."
      />
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-hidden rounded-md border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>원본명</TableHead>
                <TableHead>표준 상품</TableHead>
                <TableHead>코드</TableHead>
                <TableHead>상태</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappingExamples.map((item) => (
                <TableRow key={item.source}>
                  <TableCell className="font-medium">{item.source}</TableCell>
                  <TableCell>{item.canonical}</TableCell>
                  <TableCell>{item.code}</TableCell>
                  <TableCell>
                    <Badge className={item.status === "확정" ? statusClass("READY") : statusClass("HOLD")}>
                      {item.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <SideNote
          title="매핑 큐"
          items={["상품명 후보 자동 추천", "ERP 품목코드 연결", "거래처 별칭 등록", "가격 차이 허용 범위", "수동 확정 이력"]}
        />
      </div>
    </section>
  );
}

function ExceptionsPage({ jobs, onOpenJob }: { jobs: Job[]; onOpenJob: (id: string) => void }) {
  const exceptions = jobs.filter((job) => job.status === "FAILED" || job.status === "HOLD" || job.failedRows > 0 || job.holdRows > 0);

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <SectionHeader
        icon={<FileWarning className="h-5 w-5" />}
        title="예외 처리"
        text="상품 매칭 불가, 가격 차이, 주소 오류, 로그인 만료 같은 문제를 모아 봅니다."
      />
      <div className="p-4">
        {exceptions.length ? (
          <div className="grid gap-2">
            {exceptions.map((job) => (
              <button
                key={job.id}
                className="rounded-md border border-slate-200 bg-slate-50 p-3 text-left hover:border-[#0f766e] hover:bg-teal-50"
                onClick={() => onOpenJob(job.id)}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{job.filename}</span>
                  <Badge className={statusClass(job.status)}>{statusLabel(job.status)}</Badge>
                </div>
                <div className="mt-1 text-sm text-slate-600">
                  {job.sourceSystem || "미지정"} · 보류 {job.holdRows}건 · 실패 {job.failedRows}건
                </div>
              </button>
            ))}
          </div>
        ) : (
          <EmptyPanel title="예외 없음" text="현재 보류나 실패가 포함된 작업이 없습니다." />
        )}
      </div>
    </section>
  );
}

function RunsPage() {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <SectionHeader
        icon={<History className="h-5 w-5" />}
        title="실행 기록"
        text="자동화 실행 단계별 로그, 작업자, 승인 대기 지점을 추적합니다."
      />
      <div className="p-4">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {runSteps.map((step, index) => (
            <div key={step} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <span className="text-xs text-slate-500">STEP {index + 1}</span>
              <h3 className="mt-1 font-semibold">{step}</h3>
              <p className="mt-2 text-sm text-slate-600">
                {index < 4 ? "작업자와 자동 검증 기록" : index === 5 ? "사용자 승인 필요" : "결과와 담당자 기록"}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ReportsPage({ jobs }: { jobs: Job[] }) {
  const totalRows = jobs.reduce((sum, job) => sum + job.totalRows, 0);
  const failedRows = jobs.reduce((sum, job) => sum + job.failedRows, 0);
  const readyRows = jobs.reduce((sum, job) => sum + job.readyRows, 0);

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <SectionHeader
        icon={<Database className="h-5 w-5" />}
        title="리포트"
        text="채널별 처리량, 실패율, 실행 대기 현황을 볼 수 있게 구성합니다."
      />
      <div className="grid gap-3 p-4 md:grid-cols-3">
        <OverviewCard label="누적 주문 행" value={totalRows} />
        <OverviewCard label="검증 완료 행" value={readyRows} />
        <OverviewCard label="실패 행" value={failedRows} />
      </div>
      <div className="border-t border-slate-200 p-4">
        <EmptyPanel title="다운로드 리포트 영역" text="작업 상세의 리포트 다운로드와 별도로, 기간·채널·실패 사유별 리포트를 이곳에 추가합니다." />
      </div>
    </section>
  );
}

function MembershipPage() {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <SectionHeader
        icon={<UserRound className="h-5 w-5" />}
        title="회원가입과 로그인"
        text="GPT 로그인 보호와 별도로, 운영 사이트 자체 회원 체계를 준비합니다."
      />
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <PolicyCard title="가입 방식" text="초대 링크 또는 관리자 등록으로 시작하고, 신규 가입은 승인 대기 상태로 둡니다." />
            <PolicyCard title="로그인 보안" text="이메일 인증, 비밀번호 재설정, 세션 만료, 실패 횟수 제한을 기본 정책으로 둡니다." />
            <PolicyCard title="작업 감사" text="업로드, 상태 변경, 승인, 주문 제출, 권한 변경은 사용자와 시간 기준으로 기록합니다." />
          </div>

          <div className="overflow-hidden rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>역할</TableHead>
                  <TableHead>허용 범위</TableHead>
                  <TableHead>예상 인원</TableHead>
                  <TableHead>제한</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {membershipRoles.map((item) => (
                  <TableRow key={item.role}>
                    <TableCell className="font-medium">{item.role}</TableCell>
                    <TableCell className="whitespace-normal">{item.scope}</TableCell>
                    <TableCell>{item.users}</TableCell>
                    <TableCell className="whitespace-normal text-slate-700">{item.risk}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-teal-700" />
              <h3 className="font-semibold">주문 실행 권한 기준</h3>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <PolicyCard title="일반 작업" text="파일 업로드, 검증 결과 확인, 보류 사유 수정은 주문 운영자 이상에게 허용합니다." />
              <PolicyCard title="외부 변경 작업" text="B2B몰 주문 확정, 결제, ERP 전표 등록은 승인 담당자 이상만 처리합니다." />
            </div>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-[#fff8e6] p-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-amber-700" />
              <h3 className="font-semibold">현재 상태</h3>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-700">
              지금 배포된 사이트는 GPT 계정 기반의 비공개 접근으로 보호됩니다. 별도 회원가입은 아직 실제 로그인 서버와 연결되지 않은 설계 단계입니다.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="font-semibold">구현 순서</h3>
            <div className="mt-3 space-y-2">
              {authRoadmap.map((item) => (
                <div key={item.title} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <span className="text-xs font-semibold text-teal-700">{item.title}</span>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{item.text}</p>
                </div>
              ))}
            </div>
          </div>
          <SideNote
            title="추가로 정할 것"
            items={["외부 직원 가입 허용 여부", "관리자 승인 담당자", "비밀번호 정책", "휴면 계정 기준", "퇴사자 계정 잠금 방식"]}
          />
        </aside>
      </div>
    </section>
  );
}

function SettingsPage() {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <SectionHeader
        icon={<Settings className="h-5 w-5" />}
        title="관리자 설정"
        text="운영자가 회원, 권한, 채널, 상품 매핑, 승인 정책을 관리하는 영역입니다."
      />
      <div className="space-y-4 p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {adminCards.map((card) => (
            <PolicyCard key={card.title} title={card.title} text={card.text} />
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <div className="border-b border-slate-200 bg-slate-50 p-4">
                <h3 className="font-semibold">회원 승인 대기</h3>
                <p className="mt-1 text-sm text-slate-600">가입 요청자는 관리자가 역할을 지정해야 주문 화면에 접근합니다.</p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>이름</TableHead>
                    <TableHead>이메일</TableHead>
                    <TableHead>요청 역할</TableHead>
                    <TableHead>상태</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingMembers.map((member) => (
                    <TableRow key={member.email}>
                      <TableCell className="font-medium">{member.name}</TableCell>
                      <TableCell>{member.email}</TableCell>
                      <TableCell>{member.request}</TableCell>
                      <TableCell>
                        <Badge className={member.status === "승인 대기" ? statusClass("HOLD") : statusClass("FAILED")}>
                          {member.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="overflow-hidden rounded-lg border border-slate-200">
              <div className="border-b border-slate-200 bg-slate-50 p-4">
                <h3 className="font-semibold">승인 정책</h3>
                <p className="mt-1 text-sm text-slate-600">외부 사이트나 ERP에 실제 변경이 생기는 작업은 승인 단계를 둡니다.</p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>작업</TableHead>
                    <TableHead>담당 권한</TableHead>
                    <TableHead>승인</TableHead>
                    <TableHead>기록</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {approvalPolicies.map((policy) => (
                    <TableRow key={policy.step}>
                      <TableCell className="font-medium">{policy.step}</TableCell>
                      <TableCell>{policy.owner}</TableCell>
                      <TableCell>
                        <Badge className={policy.approval === "불필요" ? statusClass("READY") : statusClass("HOLD")}>
                          {policy.approval}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-normal">{policy.log}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <aside className="space-y-4">
            <SideNote
              title="관리자만 바꾸는 값"
              items={["회원 승인과 차단", "역할별 권한", "채널 로그인 정책", "상품·거래처 매핑 기준", "가격 차이 허용 범위", "주문 제출 승인 단계"]}
            />
            <div className="rounded-lg border border-slate-200 bg-[#fff8e6] p-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-amber-700" />
                <h3 className="font-semibold">운영 원칙</h3>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-700">
                관리자가 설정을 바꾸면 설정 변경자와 시간이 기록되어야 합니다. 주문 작업 로그와 같은 기준으로 남겨야 나중에 문제가 생겨도 추적할 수 있습니다.
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <h3 className="font-semibold">다음 구현</h3>
              <div className="mt-3 space-y-2 text-sm text-slate-600">
                <p className="rounded-md border border-slate-200 bg-slate-50 p-3">회원 승인 버튼과 역할 변경 저장</p>
                <p className="rounded-md border border-slate-200 bg-slate-50 p-3">채널별 로그인 정보 보관 방식 결정</p>
                <p className="rounded-md border border-slate-200 bg-slate-50 p-3">상품 매핑 DB와 변경 이력 연결</p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

function SectionHeader({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-slate-200 p-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-teal-50 text-teal-700">{icon}</span>
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-slate-600">{text}</p>
      </div>
    </div>
  );
}

function SideNote({ title, items }: { title: string; items: string[] }) {
  return (
    <aside className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <h3 className="font-semibold">{title}</h3>
      <ul className="mt-3 space-y-2 text-sm text-slate-600">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 text-teal-700" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function EmptyPanel({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-slate-600">{text}</p>
    </div>
  );
}

function OrderTable({ rows }: { rows: OrderRow[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-slate-200">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">행</TableHead>
            <TableHead>상태</TableHead>
            <TableHead>출처</TableHead>
            <TableHead>주문번호</TableHead>
            <TableHead>상품</TableHead>
            <TableHead>수량</TableHead>
            <TableHead>수취인</TableHead>
            <TableHead>배송지</TableHead>
            <TableHead>사유</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.lineNo}-${row.orderId}-${row.productName}`}>
              <TableCell>{row.lineNo}</TableCell>
              <TableCell>
                <Badge className={statusClass(row.status)}>{statusLabel(row.status)}</Badge>
              </TableCell>
              <TableCell>{row.sourceSystem || "미지정"}</TableCell>
              <TableCell>{row.orderId || "-"}</TableCell>
              <TableCell className="max-w-[220px] whitespace-normal font-medium">
                {row.productName || "-"}
                {row.option ? <div className="text-xs font-normal text-slate-700">옵션: {row.option}</div> : null}
                <div className="text-xs font-normal text-slate-500">{row.category}</div>
              </TableCell>
              <TableCell>{row.quantity || "-"}</TableCell>
              <TableCell>
                {row.recipientName || "-"}
                <div className="text-xs text-slate-500">{row.recipientPhone}</div>
              </TableCell>
              <TableCell className="max-w-[260px] whitespace-normal">
                {row.address} {row.addressDetail}
              </TableCell>
              <TableCell className="max-w-[260px] whitespace-normal text-slate-700">
                {row.reason || "주문 전 검증 통과"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
      <FileSpreadsheet className="mb-3 h-10 w-10 text-slate-400" />
      <h3 className="font-semibold">주문 CSV를 업로드하세요</h3>
      <p className="mt-2 max-w-xl text-sm text-slate-600">
        CSV 컬럼은 order_id, category, product_name, quantity, customer_name, recipient_name,
        recipient_phone, address를 포함해야 합니다.
      </p>
      <Button className="mt-4" variant="outline" onClick={downloadSample}>
        <Download className="h-4 w-4" />
        샘플 CSV
      </Button>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "neutral" | "ready" | "hold" | "failed";
}) {
  const colors = {
    neutral: "bg-slate-100 text-slate-700",
    ready: "bg-emerald-50 text-emerald-700",
    hold: "bg-amber-50 text-amber-700",
    failed: "bg-rose-50 text-rose-700",
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-600">{label}</span>
        <span className={`flex h-8 w-8 items-center justify-center rounded-md ${colors[tone]}`}>{icon}</span>
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight">{value.toLocaleString()}</div>
    </div>
  );
}

function PolicyCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
    </div>
  );
}
