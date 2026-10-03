// Purge des donnees brutes Umami de plus de 13 mois (engagement des pages
// cookies et confidentialite). Mode par defaut : lecture seule (comptage).
// La suppression reelle exige UMAMI_PURGE_APPLY=1 dans l'environnement Vercel.
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const RETENTION_MONTHS = 13;
const MAX_ROWS_PER_TABLE = Number(process.env.UMAMI_PURGE_MAX_ROWS || 50000);

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const apply = process.env.UMAMI_PURGE_APPLY === '1';
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);

  const db = prisma.client as any;
  const result: Record<string, number> = {};

  // Ordre : donnees liees d'abord, puis evenements, puis sessions.
  // Ordre : donnees liees d'abord, puis evenements, puis sessions.
  const steps: { name: string; count: string; del: string }[] = [
    {
      name: 'heatmap_event',
      count: 'SELECT count(*)::int AS n FROM heatmap_event WHERE created_at < $1',
      del: 'DELETE FROM heatmap_event WHERE ctid IN (SELECT ctid FROM heatmap_event WHERE created_at < $1 LIMIT $2)',
    },
    {
      name: 'session_replay',
      count: 'SELECT count(*)::int AS n FROM session_replay WHERE created_at < $1',
      del: 'DELETE FROM session_replay WHERE ctid IN (SELECT ctid FROM session_replay WHERE created_at < $1 LIMIT $2)',
    },
    {
      name: 'revenue',
      count: 'SELECT count(*)::int AS n FROM revenue WHERE created_at < $1',
      del: 'DELETE FROM revenue WHERE ctid IN (SELECT ctid FROM revenue WHERE created_at < $1 LIMIT $2)',
    },
    {
      name: 'event_data',
      count: 'SELECT count(*)::int AS n FROM event_data WHERE created_at < $1',
      del: 'DELETE FROM event_data WHERE ctid IN (SELECT ctid FROM event_data WHERE created_at < $1 LIMIT $2)',
    },
    {
      name: 'website_event',
      count: 'SELECT count(*)::int AS n FROM website_event WHERE created_at < $1',
      del: 'DELETE FROM website_event WHERE ctid IN (SELECT ctid FROM website_event WHERE created_at < $1 LIMIT $2)',
    },
    {
      name: 'session_data',
      count: 'SELECT count(*)::int AS n FROM session_data WHERE created_at < $1',
      del: 'DELETE FROM session_data WHERE ctid IN (SELECT ctid FROM session_data WHERE created_at < $1 LIMIT $2)',
    },
    {
      name: 'session_link',
      count: 'SELECT count(*)::int AS n FROM session_link WHERE created_at < $1',
      del: 'DELETE FROM session_link WHERE ctid IN (SELECT ctid FROM session_link WHERE created_at < $1 LIMIT $2)',
    },
    {
      // Une session n'est supprimee que si elle n'a plus aucun evenement.
      name: 'session',
      count:
        'SELECT count(*)::int AS n FROM session s WHERE s.created_at < $1 AND NOT EXISTS (SELECT 1 FROM website_event e WHERE e.session_id = s.session_id)',
      del: 'DELETE FROM session WHERE ctid IN (SELECT s.ctid FROM session s WHERE s.created_at < $1 AND NOT EXISTS (SELECT 1 FROM website_event e WHERE e.session_id = s.session_id) LIMIT $2)',
    },
  ];

  for (const step of steps) {
    const rows = (await db.$queryRawUnsafe(step.count, cutoff)) as { n: number }[];
    const eligible = rows[0]?.n ?? 0;
    if (apply && eligible > 0) {
      result[step.name] = Number(await db.$executeRawUnsafe(step.del, cutoff, MAX_ROWS_PER_TABLE));
    } else {
      result[step.name] = eligible;
    }
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    cutoff: cutoff.toISOString(),
    cap_per_table: MAX_ROWS_PER_TABLE,
    [apply ? 'deleted' : 'would_delete']: result,
  };
  console.log('[umami-purge]', JSON.stringify(report));
  return NextResponse.json(report);
}
