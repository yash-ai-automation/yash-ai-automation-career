export function buildTrace(runRow, events = []) {
  return {
    id: `trace-${runRow.id}`,
    type: 'trace-create',
    timestamp: runRow.created_at,
    body: {
      id: `run-${runRow.id}`,
      name: 'yash-resume-pipeline',
      input: runRow.url,
      output: runRow.pdf_path,
      metadata: {
        git_sha: runRow.git_sha,
        exit_code: runRow.exit_code,
        tokens_in: runRow.tokens_in,
        tokens_out: runRow.tokens_out
      }
    },
    observations: events.map((e, i) => ({
      id: `obs-${runRow.id}-${i}`,
      traceId: `trace-${runRow.id}`,
      name: e.phase,
      startTime: e.start,
      endTime: e.end
    }))
  };
}

export async function postBatch({ httpClient, host, publicKey, secretKey }, batch) {
  const authHeader = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  try {
    const res = await httpClient(`${host}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ batch })
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Langfuse auth failed (status ${res.status})`);
    }
    return res.ok;
  } catch (e) {
    if (/auth/i.test(e.message)) throw e;
    return false;
  }
}
