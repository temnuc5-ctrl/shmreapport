import { useState } from "react";
import Layout from "@/components/Layout";
import { API_BASE, getAuthHeaders } from "@/lib/auth";
import { BarChart3, CalendarDays, Download, Loader2 } from "lucide-react";

type ReportMode = "sequence" | "rapide";
type ReportLanguage = "ar" | "fr";

interface ReportResult {
  status?: "pending" | "running" | "completed";
  job_id?: string;
  pdf_url?: string;
  period?: { from?: string; to?: string };
  reports?: number;
  sessions?: number;
  participants_total?: number;
  girls_ratio_pct?: number;
  sessions_without_report?: number;
  recurring_negative?: string[];
  synthesis_used?: boolean;
}

const DEFAULT_QUESTION = "Rapport général de la séquence : ce qui a été fait, ce qui ne l'a pas été, ce qui se répète";

export default function SequenceReport() {
  const [mode, setMode] = useState<ReportMode>("sequence");
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [title, setTitle] = useState("تقرير عام للفترة");
  const [language, setLanguage] = useState<ReportLanguage>("ar");
  const [category, setCategory] = useState("");
  const [tables, setTables] = useState("reports,sessions");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE}/api/rapport`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          question,
          ...(dateFrom ? { date_from: dateFrom } : {}),
          ...(dateTo ? { date_to: dateTo } : {}),
          title,
          language,
          ...(mode === "rapide" ? { category, tables } : {}),
        }),
      });
      const body = await response.json().catch(() => null) as (ReportResult & { error?: string }) | null;
      if (!response.ok) throw new Error(body?.error || `Erreur de génération (${response.status}).`);
      if (!body?.job_id) throw new Error("CREAO n’a pas retourné de numéro de suivi.");

      let completedReport: ReportResult | null = null;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
        const pollResponse = await fetch(`${API_BASE}/api/rapport/${encodeURIComponent(body.job_id)}`, {
          headers: getAuthHeaders(),
        });
        const pollBody = await pollResponse.json().catch(() => null) as (ReportResult & { status?: string; error?: string }) | null;
        if (!pollResponse.ok) throw new Error(pollBody?.error || `Erreur de suivi (${pollResponse.status}).`);
        if (pollBody?.status === "completed" && pollBody.pdf_url) {
          completedReport = pollBody;
          break;
        }
      }
      if (!completedReport) throw new Error("La génération prend trop de temps. Réessayez dans quelques instants.");
      setResult(completedReport);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de générer le rapport.");
    } finally {
      setLoading(false);
    }
  };

  const labelClass = "block text-sm font-bold text-gray-600";
  const inputClass = "mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 font-medium text-gray-800 outline-none transition focus:border-primary focus:bg-white";

  return (
    <Layout>
      <div className="mx-auto max-w-4xl space-y-8" dir="rtl">
        <header className="space-y-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl shm-gradient text-white shadow-lg shadow-primary/20">
            <BarChart3 size={26} />
          </div>
          <h1 className="text-3xl font-black shm-text-gradient md:text-4xl">تقارير Supabase</h1>
          <p className="max-w-2xl text-sm leading-7 text-gray-500">إنشاء تقرير تسلسلي أو تقرير مؤشرات PDF وفق الشارة الرسمية، عبر adnane.ai / CREAO.</p>
        </header>

        <form onSubmit={submit} className="shm-card space-y-6">
          <label className={labelClass}>
            نوع التقرير
            <select value={mode} onChange={(event) => setMode(event.target.value as ReportMode)} className={inputClass}>
              <option value="sequence">تقرير عام للفترة</option>
              <option value="rapide">تقرير المؤشرات السريع</option>
            </select>
          </label>

          <label className={labelClass}>
            السؤال الذي يجب أن يجيب عنه التقرير
            <textarea required maxLength={2000} rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} className={inputClass} />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              بداية الفترة {mode === "sequence" && <span className="text-red-700">*</span>}
              <span className="relative mt-2 block">
                <CalendarDays size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="date" required={mode === "sequence"} value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} className={`${inputClass} mt-0 pl-11`} />
              </span>
            </label>
            <label className={labelClass}>
              نهاية الفترة {mode === "sequence" && <span className="text-red-700">*</span>}
              <span className="relative mt-2 block">
                <CalendarDays size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="date" required={mode === "sequence"} value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} className={`${inputClass} mt-0 pl-11`} />
              </span>
            </label>
          </div>
          {mode === "rapide" && <p className="-mt-4 text-xs font-medium text-gray-400">الفترة اختيارية في تقرير المؤشرات.</p>}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              لغة التقرير
              <select value={language} onChange={(event) => setLanguage(event.target.value as ReportLanguage)} className={inputClass}>
                <option value="ar">العربية</option>
                <option value="fr">Français</option>
              </select>
            </label>
            <label className={labelClass}>
              عنوان PDF
              <input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} className={inputClass} />
            </label>
          </div>

          {mode === "rapide" && (
            <div className="grid gap-4 border-t border-gray-100 pt-5 sm:grid-cols-2">
              <label className={labelClass}>
                تصفية الفئة أو الجمهور المستهدف
                <input value={category} maxLength={120} onChange={(event) => setCategory(event.target.value)} placeholder="اختياري" className={inputClass} />
              </label>
              <label className={labelClass}>
                الجداول (قائمة مفصولة بفواصل)
                <input value={tables} onChange={(event) => setTables(event.target.value)} placeholder="reports,sessions" className={inputClass} dir="ltr" />
              </label>
            </div>
          )}

          {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

          <button type="submit" disabled={loading} className="flex w-full items-center justify-center gap-3 rounded-xl shm-gradient px-6 py-4 font-black text-white shadow-lg shadow-primary/20 transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
            {loading ? <><Loader2 size={19} className="animate-spin" />جاري إعداد التقرير ومتابعة التنفيذ…</> : "إنشاء تقرير PDF"}
          </button>
        </form>

        {result && (
          <section className="shm-card space-y-5" aria-live="polite">
            <div>
              <h2 className="text-xl font-black text-gray-800">اكتمل التقرير</h2>
              {result.period?.from && result.period?.to && <p className="mt-1 text-sm text-gray-500">الفترة: {result.period.from} — {result.period.to}</p>}
            </div>
            <a href={result.pdf_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-xl shm-gradient px-5 py-3 text-sm font-black text-white">
              <Download size={18} /> فتح PDF
            </a>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {result.reports !== undefined && <Metric label="التقارير" value={result.reports} />}
              {result.sessions !== undefined && <Metric label="الحصص" value={result.sessions} />}
              {result.participants_total !== undefined && <Metric label="المشاركون" value={result.participants_total} />}
              {result.girls_ratio_pct !== undefined && <Metric label="نسبة الإناث" value={`${result.girls_ratio_pct}%`} />}
              {result.sessions_without_report !== undefined && <Metric label="حصص بلا تقرير" value={result.sessions_without_report} />}
              {result.synthesis_used !== undefined && <Metric label="تم استخدام التلخيص" value={result.synthesis_used ? "نعم" : "لا"} />}
            </dl>
            {!!result.recurring_negative?.length && (
              <div>
                <h3 className="font-black text-gray-700">النقاط السلبية المتكررة</h3>
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-gray-600">
                  {result.recurring_negative.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                </ul>
              </div>
            )}
            <p className="text-xs leading-6 text-gray-400">رابط PDF عام؛ لا تشاركه إلا مع الأشخاص المصرح لهم.</p>
          </section>
        )}
      </div>
    </Layout>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-xl border border-[#d8c9a9] bg-[#fdf8ee] p-4"><dt className="text-xs font-bold text-[#5f4a2b]">{label}</dt><dd className="mt-1 text-xl font-black text-[#8b0000]">{value}</dd></div>;
}
