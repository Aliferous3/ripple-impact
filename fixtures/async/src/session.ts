export function fetchSession(id: string): Promise<string> {
  return Promise.resolve(`session:${id}`);
}
