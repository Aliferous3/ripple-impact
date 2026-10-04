import { Panel } from "./panel.js";
import { Button as Btn } from "./button.js";
import * as UI from "./ui.js";

const widgets = {
  helper() {
    return null;
  },
};

export function App() {
  return (
    <main>
      <Panel></Panel>
      <Btn label="x" />
      <UI.Button label="y" />
      <widgets.helper />
      <span />
    </main>
  );
}
