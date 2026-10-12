import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { api, type Provider, type StoredCredential } from '../api';
import { useMeta } from '../state';
import { fullDate } from '../format';
import { ErrorBox, Field, Modal } from './ui';

/**
 * Hosted only: the visitor's own bank and card logins. They are sent to a server the visitor does
 * not control, encrypted into that session's container and destroyed with it — which the dialog says
 * in so many words, behind a checkbox, before it will submit anything.
 */

const REPO_URL = 'https://github.com/nmazuz/familycfo';

export function ConnectBank() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => api.get<StoredCredential[]>('/credentials') });
  const remove = useMutation({
    mutationFn: (companyId: string) => api.del(`/credentials/${companyId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  });

  const rows = credentials.data ?? [];

  return (
    <>
      {credentials.error && <ErrorBox error={credentials.error} />}
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">עוד לא חובר חשבון. אפשר לחבר בנק או חברת אשראי ולמשוך את התנועות האמיתיות שלך.</p>
      ) : (
        <ul className="divide-y divide-line-soft rounded-(--radius-panel) border">
          {rows.map(c => (
            <li key={c.companyId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <Landmark className="h-4 w-4 shrink-0 text-fg-subtle" />
              <span className="font-medium">{c.name}</span>
              <span className="text-fg-subtle">····{c.hint ?? '····'}</span>
              <span className="text-xs text-fg-subtle">עודכן {fullDate(c.updatedAt)}</span>
              <button type="button" className="btn-ghost ms-auto text-rose-600 hover:text-rose-700 dark:text-rose-400"
                disabled={remove.isPending} onClick={() => remove.mutate(c.companyId)}>
                <Trash2 className="h-4 w-4" />מחק
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <button type="button" className="btn" onClick={() => setOpen(true)}><Plus />חיבור בנק או כרטיס</button>
      </div>
      {open && <ConnectDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const meta = useMeta();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<Provider[]>('/providers') });
  const [companyId, setCompanyId] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [eraseAcknowledged, setEraseAcknowledged] = useState(false);

  // the demo household and a real bank cannot share one database: saving a real login wipes the demo
  const demoSeeded = meta.data?.settings.demo_seeded === '1';
  const provider = providers.data?.find(p => p.companyId === companyId);

  const save = useMutation({
    mutationFn: async () => {
      if (!provider) throw new Error('בחרו ספק');
      if (demoSeeded) await api.post('/household/reset', {});
      await api.put(`/credentials/${provider.companyId}`, { fields });
    },
    onSuccess: () => {
      qc.invalidateQueries();
      onClose();
    },
  });

  const complete = !!provider && provider.loginFields.every(f => (fields[f.name] ?? '').trim().length > 0);
  const canSubmit = complete && acknowledged && (!demoSeeded || eraseAcknowledged) && !save.isPending;

  return (
    <Modal
      title="חיבור בנק או כרטיס"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost" onClick={onClose}>ביטול</button>
        <button type="button" className="btn-primary" disabled={!canSubmit} onClick={() => save.mutate()}>
          {save.isPending ? 'שומר…' : 'שמירה'}
        </button>
      </>}
    >
      <div className="rounded-(--radius-panel) border border-amber-300 bg-amber-50/70 p-3 text-sm leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
        <div className="mb-1 flex items-center gap-2 font-semibold"><ShieldAlert className="h-4 w-4 shrink-0" />לפני שממשיכים</div>
        <ul className="list-disc space-y-1 ps-5">
          <li>פרטי ההתחברות נשלחים לשרת שאינך שולט/ת בו ומשמשים להתחברות לאתר הבנק בשמך.</li>
          <li>הם נשמרים מוצפנים בתוך המכולה (container) של המפגש הזה בלבד, ולא מוחזרים לעולם על ידי שום בקשה.</li>
          <li>כשהמפגש נסגר המכולה נמחקת, ואיתה גם הפרטים וגם מפתח ההצפנה.</li>
          <li>
            הדרך הפרטית לחלוטין היא להריץ את האפליקציה אצלך במחשב —{' '}
            <a className="underline" href={REPO_URL} target="_blank" rel="noreferrer">הוראות ההתקנה ב-GitHub</a>.
          </li>
        </ul>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />
        <span>אני מבין/ה שהפרטים נשלחים לשרת שאינני שולט/ת בו</span>
      </label>

      {demoSeeded && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={eraseAcknowledged} onChange={e => setEraseAcknowledged(e.target.checked)} />
          <span>אני מאשר/ת שהשמירה תמחק את נתוני הדמו הקיימים ותתחיל משק בית ריק</span>
        </label>
      )}

      <Field label="ספק">
        <select className="input" value={companyId} autoComplete="off"
          onChange={e => { setCompanyId(e.target.value); setFields({}); }}>
          <option value="">בחרו בנק או חברת אשראי…</option>
          {(providers.data ?? []).map(p => <option key={p.companyId} value={p.companyId}>{p.name}</option>)}
        </select>
      </Field>

      {provider?.loginFields.map(f => (
        <Field key={f.name} label={f.name}>
          <input className="input" type={f.secret ? 'password' : 'text'} autoComplete="off" value={fields[f.name] ?? ''}
            onChange={e => setFields(prev => ({ ...prev, [f.name]: e.target.value }))} />
        </Field>
      ))}

      {save.error && <ErrorBox error={save.error} />}
    </Modal>
  );
}
