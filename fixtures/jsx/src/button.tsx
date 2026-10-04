export function Button(props: { label: string }) {
  return <button title={props.label}>{props.label}</button>;
}
