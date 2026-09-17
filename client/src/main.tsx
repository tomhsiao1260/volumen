import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import "./style.css";

createRoot(document.querySelector("#root") as HTMLElement).render(<App />);
