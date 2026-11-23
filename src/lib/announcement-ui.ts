import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import type { SiteAnnouncementType } from "@/lib/system-settings";

export interface AnnouncementVariantStyle {
  type: SiteAnnouncementType;
  badge: string;
  buttonLabel: string;
  shortLabel: string;
  hex: string;
  containerClass: string;
  badgeClass: string;
  statusBadgeClass: string;
  activeButtonClass: string;
  idleButtonClass: string;
  Icon: typeof Info;
}

export const ANNOUNCEMENT_VARIANTS: Record<
  SiteAnnouncementType,
  AnnouncementVariantStyle
> = {
  IMPORTANT: {
    type: "IMPORTANT",
    badge: "IMPORTANT",
    buttonLabel: "ROUGE · IMPORTANT",
    shortLabel: "ROUGE IMPORTANT",
    hex: "#C83E4D",
    containerClass: "border-carmine bg-carmine/10 text-ink",
    badgeClass: "bg-carmine text-card",
    statusBadgeClass: "border-carmine bg-carmine/10 text-carmine",
    activeButtonClass: "border-carmine bg-carmine text-card",
    idleButtonClass:
      "border-carmine/40 bg-carmine/10 text-carmine hover:bg-carmine/20",
    Icon: ShieldAlert,
  },
  INFO: {
    type: "INFO",
    badge: "INFORMATION",
    buttonLabel: "BLEU · INFO",
    shortLabel: "BLEU INFO",
    hex: "#2B547E",
    containerClass: "border-badge-text bg-badge-bg text-ink",
    badgeClass: "bg-badge-text text-card",
    statusBadgeClass: "border-badge-text/50 bg-badge-bg text-badge-text",
    activeButtonClass: "border-badge-text bg-badge-text text-card",
    idleButtonClass:
      "border-badge-text/40 bg-badge-bg text-badge-text hover:bg-badge-text/15",
    Icon: Info,
  },
  PREVENTION: {
    type: "PREVENTION",
    badge: "PRÉVENTION",
    buttonLabel: "ORANGE · PRÉVENTION",
    shortLabel: "ORANGE PRÉVENTION",
    hex: "#D99B26",
    containerClass: "border-amber bg-amber/15 text-ink",
    badgeClass: "bg-amber text-ink",
    statusBadgeClass: "border-amber bg-amber/15 text-ink",
    activeButtonClass: "border-amber bg-amber text-ink",
    idleButtonClass:
      "border-amber/60 bg-amber/15 text-ink hover:bg-amber/30",
    Icon: AlertTriangle,
  },
};

export const ANNOUNCEMENT_VARIANT_LIST: AnnouncementVariantStyle[] = [
  ANNOUNCEMENT_VARIANTS.IMPORTANT,
  ANNOUNCEMENT_VARIANTS.INFO,
  ANNOUNCEMENT_VARIANTS.PREVENTION,
];
