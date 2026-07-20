type ForegroundPreemptor = () => void;

let activeWorkCount = 0;
const preemptors = new Set<ForegroundPreemptor>();

export function beginForegroundLlmWork(): () => void {
  activeWorkCount += 1;
  for (const preempt of preemptors) preempt();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWorkCount = Math.max(0, activeWorkCount - 1);
  };
}

export function isForegroundLlmBusy(): boolean {
  return activeWorkCount > 0;
}

export function registerForegroundLlmPreemptor(preempt: ForegroundPreemptor): () => void {
  preemptors.add(preempt);
  return () => preemptors.delete(preempt);
}

export function resetForegroundLlmActivityForTests(): void {
  activeWorkCount = 0;
  preemptors.clear();
}
