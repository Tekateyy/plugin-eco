import { Finding, Score, WorkspaceReport } from './types';
import { scoreSummary } from './scoring';

const DPE_COLORS: Record<Score['letter'], { bg: string; fg: string }> = {
  A: { bg: '#00A550', fg: '#ffffff' },
  B: { bg: '#52B747', fg: '#ffffff' },
  C: { bg: '#F0E729', fg: '#1a1a1a' },
  D: { bg: '#F7A329', fg: '#ffffff' },
  E: { bg: '#EC1C24', fg: '#ffffff' },
};

const SEVERITY_LABELS: Record<Finding['severity'], { label: string; color: string }> = {
  high:   { label: 'Haute',   color: '#EC1C24' },
  medium: { label: 'Moyenne', color: '#F7A329' },
  low:    { label: 'Faible',  color: '#52B747' },
};

// ---------------------------------------------------------------------------
// Composants réutilisables
// ---------------------------------------------------------------------------

function dpeStrip(activeLetter: Score['letter']): string {
  return (['A', 'B', 'C', 'D', 'E'] as Score['letter'][])
    .map(l => {
      const c = DPE_COLORS[l];
      const active = l === activeLetter;
      return `<div class="dpe-box${active ? ' active' : ''}"
                   style="background:${c.bg};color:${c.fg}">${l}</div>`;
    })
    .join('');
}

function sharedStyles(): string {
  return `
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 24px;
    margin: 0;
  }
  h1 { font-size: 1.1em; margin: 0 0 4px; opacity: 0.7; font-weight: 400; }
  .subtitle { font-size: 0.85em; opacity: 0.5; margin-bottom: 20px; word-break: break-all; }
  .dpe-strip { display: flex; gap: 6px; align-items: flex-end; margin-bottom: 8px; }
  .dpe-box {
    width: 44px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 1em;
    border-radius: 3px; opacity: 0.28;
  }
  .dpe-box.active {
    opacity: 1; height: 52px; font-size: 1.4em;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  .score-line { font-size: 0.9em; margin-bottom: 6px; font-weight: 600; }
  .summary { font-size: 0.85em; opacity: 0.6; margin-bottom: 24px; }
  h2 {
    font-size: 0.95em; margin: 0 0 10px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    padding-bottom: 6px;
  }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 0.8em; opacity: 0.55; font-weight: 600;
    padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #444);
  }
  td {
    padding: 6px 8px; vertical-align: top;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    font-size: 0.88em;
  }
  tr:last-child td { border-bottom: none; }
  .col-line { white-space: nowrap; opacity: 0.55; font-family: monospace; }
  .col-msg { line-height: 1.45; }
  .col-file { font-family: monospace; font-size: 0.85em; }
  .col-score { text-align: center; }
  td.empty { text-align: center; padding: 20px; opacity: 0.6; }
  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 10px;
    font-size: 0.8em; font-weight: 700; color: #fff; white-space: nowrap;
  }
  .letter-badge {
    display: inline-block; width: 24px; height: 24px; line-height: 24px;
    text-align: center; border-radius: 3px; font-weight: 700; font-size: 0.9em;
  }
  .clickable { cursor: pointer; }
  .clickable:hover td { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }`;
}

// ---------------------------------------------------------------------------
// Rapport fichier unique
// ---------------------------------------------------------------------------

/** Génère le HTML du panneau mono-fichier (pas de scripts nécessaires). */
export function buildWebviewHtml(
  findings: Finding[],
  score: Score,
  fileName: string,
  nonce: string
): string {
  const color = DPE_COLORS[score.letter];
  const total = findings.length;
  const { high, medium } = score.findingCount;

  const sorted = [...findings].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.severity] - order[b.severity];
  });

  const rows = sorted.length === 0
    ? `<tr><td colspan="3" class="empty">Aucun pattern énergivore détecté 🎉</td></tr>`
    : sorted.map(f => {
        const sv = SEVERITY_LABELS[f.severity];
        return `<tr>
          <td class="col-line">L.${f.startLine + 1}</td>
          <td><span class="badge" style="background:${sv.color}">${sv.label}</span></td>
          <td class="col-msg">${esc(f.message)}</td>
        </tr>`;
      }).join('');

  return html(`
    <h1>⚡ Rapport éco — fichier</h1>
    <div class="subtitle">${esc(fileName)}</div>

    <div class="dpe-strip">${dpeStrip(score.letter)}</div>
    <div class="score-line" style="color:${color.bg}">${score.value}/100 — ${scoreSummary(score)}</div>
    <div class="summary">${
      total === 0
        ? 'Aucune alerte.'
        : `${total} alerte${total > 1 ? 's' : ''} : ${high} haute${high > 1 ? 's' : ''}, ${medium} moyenne${medium > 1 ? 's' : ''}`
    }</div>

    <h2>Détail des alertes</h2>
    <table>
      <thead><tr><th>Ligne</th><th>Sévérité</th><th>Message</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `, nonce);
}

// ---------------------------------------------------------------------------
// Rapport workspace
// ---------------------------------------------------------------------------

/** Génère le HTML du panneau workspace avec lignes cliquables (requiert enableScripts). */
export function buildWorkspaceHtml(report: WorkspaceReport, nonce: string): string {
  const { global, files, scannedAt } = report;
  const color = DPE_COLORS[global.letter];
  const totalFiles = files.length;
  const { high, medium } = global.findingCount;

  const rows = files.map(f => {
    const c = DPE_COLORS[f.score.letter];
    const firstLine = f.findings.length > 0 ? f.findings[0].startLine + 1 : 1;
    const totalFindings = f.findings.length;
    return `<tr class="clickable"
                data-uri="${esc(f.uri)}"
                data-line="${firstLine}">
      <td class="col-file">${esc(f.fileName)}</td>
      <td class="col-score">
        <span class="letter-badge" style="background:${c.bg};color:${c.fg}">${f.score.letter}</span>
        <span style="opacity:0.6;font-size:0.85em;margin-left:4px">${f.score.value}</span>
      </td>
      <td>${totalFindings > 0
            ? `${totalFindings} alerte${totalFindings > 1 ? 's' : ''}`
            : '<span style="opacity:0.4">–</span>'
          }</td>
    </tr>`;
  }).join('');

  const script = `
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.querySelectorAll('.clickable').forEach(row => {
        row.addEventListener('click', () => {
          vscode.postMessage({
            command: 'open',
            file: row.dataset.uri,
            line: parseInt(row.dataset.line, 10)
          });
        });
      });
    </script>`;

  return html(`
    <h1>⚡ Rapport éco — workspace</h1>
    <div class="subtitle">Analysé le ${esc(scannedAt)} · ${totalFiles} fichier${totalFiles > 1 ? 's' : ''}</div>

    <div class="dpe-strip">${dpeStrip(global.letter)}</div>
    <div class="score-line" style="color:${color.bg}">${global.value}/100 (moyenne) — ${scoreSummary(global)}</div>
    <div class="summary">${high + medium} alerte${(high + medium) > 1 ? 's' : ''} au total : ${high} haute${high > 1 ? 's' : ''}, ${medium} moyenne${medium > 1 ? 's' : ''}</div>

    <h2>Fichiers — pires en premier</h2>
    <table>
      <thead><tr><th>Fichier</th><th>Score</th><th>Alertes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${script}
  `, nonce, `script-src 'nonce-${nonce}';`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function html(body: string, nonce: string, extraCsp = ''): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; ${extraCsp}">
<style>${sharedStyles()}</style>
</head>
<body>${body}</body>
</html>`;
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
