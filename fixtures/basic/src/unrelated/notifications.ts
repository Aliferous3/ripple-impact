export function formatNotification(message: string): string {
  return `[notification] ${message}`;
}

export function sendNotification(message: string): void {
  const formatted = formatNotification(message);
  console.log(formatted);
}
