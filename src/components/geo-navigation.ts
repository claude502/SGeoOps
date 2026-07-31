import {
  BarChart3,
  Bot,
  Building2,
  FileText,
  Megaphone,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type NavSection =
  | "overview"
  | "assets"
  | "runs"
  | "channels"
  | "settings";

type LocalPanelNavItem = {
  id: NavSection;
  label: string;
  icon: LucideIcon;
};

type OperationsNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export const LOCAL_PANEL_NAV_ITEMS: readonly LocalPanelNavItem[] = [
  { id: "overview", label: "总览 / Overview", icon: BarChart3 },
  { id: "assets", label: "资产 / Assets", icon: FileText },
  { id: "runs", label: "监测 / GEO Runs", icon: Bot },
  { id: "channels", label: "渠道 / Channels", icon: Megaphone },
  { id: "settings", label: "设置 / Settings", icon: Settings },
];

export const OPERATIONS_NAV_ITEMS: readonly OperationsNavItem[] = [
  {
    href: "/clients",
    label: "客户 / Clients",
    icon: Building2,
  },
];
