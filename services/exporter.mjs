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
