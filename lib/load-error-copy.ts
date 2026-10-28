const UNREACHABLE = /HTTP 5\d\d|time(d)? ?out|disconnect|not connected|unavailable|unreachable|ECONN|fetch failed|network/i;

export function loadErrorCopy(error: string, machineName: string): string {
  return UNREACHABLE.test(error) ? `Can't reach ${machineName}.` : `Couldn't get stats from ${machineName}.`;
}
