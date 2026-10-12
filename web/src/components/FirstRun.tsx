import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Landmark, LayoutDashboard, Sparkles } from 'lucide-react';
import { api } from '../api';
import { useFeatures } from '../state';
import { ErrorBox, PageHeader, SectionTitle } from './ui';

/**
 * Hosted only, and only while the household is empty: the visitor picks between made-up data and
 * their own bank. Nothing is seeded on boot, so this screen is the whole first-run experience.
 */
export function FirstRun() {
  const qc = useQueryClient();
  const features = useFeatures();
  const demo = useMutation({
    mutationFn: () => api.post<Record<string, number>>('/household/demo', {}),
    onSuccess: () => qc.invalidateQueries(),
  });

  return (
    <>
      <PageHeader title="ברוכים הבאים" icon={LayoutDashboard}
        subtitle="משק הבית הזה ריק, וקיים רק במפגש הנוכחי בדפדפן — כשהוא נסגר, הנתונים נמחקים." />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <SectionTitle icon={Sparkles} color="var(--chart-1)">נתוני דמו</SectionTitle>
          <p className="mt-3 text-sm leading-relaxed text-fg-subtle">
            משק בית מומצא עם חצי שנה של תנועות, כרטיסים, תשלומים, ביטוחים והשקעות — כדי לראות מה האפליקציה עושה,
            בלי למסור שום פרט אמיתי.
          </p>
          <button type="button" className="btn-primary mt-4" disabled={demo.isPending} onClick={() => demo.mutate()}>
            {demo.isPending ? 'בונה…' : 'טען נתוני דמו'}
          </button>
          {demo.error && <div className="mt-3"><ErrorBox error={demo.error} /></div>}
        </div>

        <div className="card">
          <SectionTitle icon={Landmark} color="var(--chart-5)">חיבור לבנק שלי</SectionTitle>
          <p className="mt-3 text-sm leading-relaxed text-fg-subtle">
            {features.scrape
              ? 'הזנת פרטי ההתחברות לבנק או לחברת האשראי, ומשיכת התנועות האמיתיות. הפרטים נשמרים מוצפנים במפגש הזה בלבד ונמחקים יחד איתו.'
              : 'סריקת בנקים כבויה במופע הזה. אפשר להריץ את האפליקציה במחשב שלך כדי לחבר חשבון אמיתי.'}
          </p>
          {features.scrape && (
            <Link className="btn mt-4" to="/settings#banks"><Landmark className="h-4 w-4" />לחיבור חשבון</Link>
          )}
        </div>
      </div>
    </>
  );
}
