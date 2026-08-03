import React, { useState } from "react";
import {
  Gauge,
  Home,
  BookOpen,
  Sliders,
  Mic,
  Brain,
  Keyboard,
  CreditCard,
  Shield,
  Wrench,
  Users,
  HelpCircle,
  UserCircle,
  UserPlus,
  X,
  Search,
} from "lucide-react";
import type { SettingsSectionType } from "./settingsSections";
import logoIcon from "../assets/icon.png";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import SupportDropdown from "./ui/SupportDropdown";
import { getCachedPlatform } from "../utils/platform";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import InviteTeammateDialog from "./InviteTeammateDialog";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import { useWorkspace } from "../hooks/useWorkspace";
import { WORKSPACES_ENABLED } from "../lib/features";

const platform = getCachedPlatform();

const rowIconClass =
  "shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150";
const rowLabelClass =
  "text-xs text-foreground/80 group-hover:text-foreground dark:text-foreground/70 dark:group-hover:text-foreground/85 transition-colors duration-150";
const rowButtonClass =
  "group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-left outline-none hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150";

// "personal-notes" is not in the sidebar. It stays in the union because meeting
// recording deep-links straight into a note (the meeting hotkey, the pending-note
// navigation drain, and the recording pill's "return to note"), so the view has to
// remain reachable even though it is no longer somewhere you can navigate to.
//
// The settings sections are views like any other: settings renders inline in the
// panel rather than in a modal, so each of its panes is a sidebar destination.
export type ControlPanelView =
  "home" | "dictionary" | "modelStats" | "personal-notes" | SettingsSectionType;

interface ControlPanelSidebarProps {
  activeView: ControlPanelView;
  onViewChange: (view: ControlPanelView) => void;
  onOpenSearch?: () => void;
  onUpgrade?: () => void;
  isOverLimit?: boolean;
  userName?: string | null;
  userEmail?: string | null;
  userImage?: string | null;
  isSignedIn?: boolean;
  authLoaded?: boolean;
  isProUser?: boolean;
  usageLoaded?: boolean;
  updateAction?: React.ReactNode;
}

export default function ControlPanelSidebar({
  activeView,
  onViewChange,
  onOpenSearch,
  onUpgrade,
  isOverLimit,
  userName,
  userEmail,
  userImage,
  isSignedIn,
  authLoaded,
  isProUser,
  usageLoaded,
  updateAction,
}: ControlPanelSidebarProps) {
  const { t } = useTranslation();
  const [upgradeDismissed, setUpgradeDismissed] = useState(
    () => localStorage.getItem("upgradeProDismissed") === "true"
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const { active: activeWorkspace } = useWorkspace();

  const showLimitBanner = authLoaded && isSignedIn && !isProUser && isOverLimit;
  const showUpgradeBanner =
    !showLimitBanner &&
    authLoaded &&
    (!isSignedIn || usageLoaded !== false) &&
    !isProUser &&
    !upgradeDismissed;

  // Settings sections come first, in the same grouping the settings modal used, so
  // the move from modal to inline does not also reshuffle where things live.
  // History and Dictionary sit at the end under their own heading.
  const navGroups: {
    label: string | null;
    items: {
      id: ControlPanelView;
      label: string;
      icon: React.ComponentType<{ size?: number; className?: string }>;
    }[];
  }[] = [
    {
      label: t("settingsModal.groups.account"),
      items: [
        { id: "account", label: t("settingsModal.sections.account.label"), icon: UserCircle },
        {
          id: "plansBilling",
          label: t("settingsModal.sections.plansBilling.label"),
          icon: CreditCard,
        },
        ...(WORKSPACES_ENABLED
          ? [
              {
                id: "workspace" as const,
                label: t("settingsModal.sections.workspace.label"),
                icon: Users,
              },
            ]
          : []),
      ],
    },
    {
      label: t("settingsModal.groups.app"),
      items: [
        { id: "general", label: t("settingsModal.sections.general.label"), icon: Sliders },
        { id: "hotkeys", label: t("settingsModal.sections.hotkeys.label"), icon: Keyboard },
      ],
    },
    {
      label: t("settingsModal.groups.aiModels"),
      items: [
        { id: "speechToText", label: t("settingsModal.sections.speechToText.label"), icon: Mic },
        { id: "llms", label: t("settingsModal.sections.llms.label"), icon: Brain },
      ],
    },
    {
      label: t("settingsModal.groups.system"),
      items: [
        { id: "privacyData", label: t("settingsModal.sections.privacyData.label"), icon: Shield },
        { id: "system", label: t("settingsModal.sections.system.label"), icon: Wrench },
      ],
    },
    {
      label: t("sidebar.groups.library"),
      items: [
        { id: "home", label: t("sidebar.history"), icon: Home },
        { id: "dictionary", label: t("sidebar.dictionary"), icon: BookOpen },
        { id: "modelStats", label: t("sidebar.modelStats"), icon: Gauge },
      ],
    },
  ];

  return (
    <div className="w-48 h-full shrink-0 border-r border-border/15 dark:border-white/6 flex flex-col bg-surface-1/60 dark:bg-surface-1">
      <div
        className="w-full h-10 shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      {WORKSPACES_ENABLED && isSignedIn && (
        <div className="px-2 pt-1 pb-1">
          <WorkspaceSwitcher userName={userName} />
        </div>
      )}

      {onOpenSearch && (
        <div className="px-2 pt-2 pb-1">
          <button
            onClick={onOpenSearch}
            className="group flex items-center w-full h-7 px-2.5 rounded-md border border-border/70 dark:border-white/25 bg-transparent hover:bg-foreground/5 dark:hover:bg-white/5 transition-colors gap-2 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
          >
            <Search size={11} className="text-muted-foreground/50 shrink-0" />
            <span className="flex-1 text-[11px] text-left text-muted-foreground/50">
              {t("commandSearch.shortPlaceholder")}
            </span>
            <div className="flex items-center gap-0.5 shrink-0">
              <kbd className="text-[10px] px-1 py-px rounded border border-border/30 dark:border-white/8 bg-muted/40 text-muted-foreground/40 font-mono leading-tight">
                {platform === "darwin" ? "⌘" : "Ctrl"}
              </kbd>
              <kbd className="text-[10px] px-1 py-px rounded border border-border/30 dark:border-white/8 bg-muted/40 text-muted-foreground/40 font-mono leading-tight">
                K
              </kbd>
            </div>
          </button>
        </div>
      )}

      {/* Scrolls: the settings panes live here now, so the list is taller than the
          window on small displays. The footer below stays pinned. */}
      <nav className="flex-1 min-h-0 overflow-y-auto flex flex-col px-2 pt-2 pb-2">
        {navGroups.map((group, groupIndex) => (
          <div key={group.label ?? groupIndex} className={groupIndex > 0 ? "mt-2.5" : ""}>
            {group.label && (
              <div className="px-2.5 pb-0.5 pt-1">
                <span className="text-[10px] font-medium tracking-[0.08em] uppercase text-foreground/40 dark:text-foreground/35">
                  {group.label}
                </span>
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activeView === item.id;

                return (
                  <button
                    key={item.id}
                    onClick={() => onViewChange(item.id)}
                    className={cn(
                      "group relative flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md outline-none transition-colors duration-150 text-left",
                      "focus-visible:ring-1 focus-visible:ring-primary/30",
                      isActive
                        ? "bg-primary/8 dark:bg-primary/10"
                        : "hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6"
                    )}
                  >
                    <Icon
                      size={15}
                      className={cn(
                        "shrink-0 transition-colors duration-150",
                        isActive
                          ? "text-primary"
                          : "text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/55 dark:group-hover:text-foreground/70"
                      )}
                    />
                    <span
                      className={cn(
                        "text-xs truncate transition-colors duration-150",
                        isActive
                          ? "text-foreground font-medium"
                          : "text-foreground/80 group-hover:text-foreground dark:text-foreground/75 dark:group-hover:text-foreground/90"
                      )}
                    >
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {showLimitBanner && (
        <div className="px-2 pb-2">
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 dark:bg-destructive/10 p-3">
            <div className="flex flex-col items-center text-center">
              <img src={logoIcon} alt="" className="w-7 h-7 rounded-md mb-2" />
              <p className="text-xs font-medium text-foreground mb-0.5">
                {t("sidebar.limitReached")}
              </p>
              <p className="text-[11px] leading-snug text-muted-foreground mb-2.5">
                {t("sidebar.limitReachedDescription")}
              </p>
              <button
                onClick={onUpgrade}
                className="w-full h-7 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
              >
                {t("sidebar.viewPlans")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpgradeBanner && (
        <div className="px-2 pb-2">
          <div className="relative rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 p-3">
            <button
              onClick={() => {
                setUpgradeDismissed(true);
                localStorage.setItem("upgradeProDismissed", "true");
              }}
              aria-label={t("common.dismiss")}
              className="absolute top-1.5 right-1.5 p-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <X size={12} />
            </button>
            <div className="flex flex-col items-center text-center pt-1">
              <img src={logoIcon} alt="" className="w-7 h-7 rounded-md mb-2" />
              <p className="text-xs font-medium text-foreground mb-0.5">
                {t("sidebar.upgradeTitle")}
              </p>
              <p className="text-[11px] leading-snug text-muted-foreground mb-2.5">
                {t("sidebar.upgradeDescription")}
              </p>
              <button
                onClick={onUpgrade}
                className="w-full h-7 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
              >
                {t("sidebar.learnMore")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-2 pb-2 space-y-0.5">
        {updateAction && (
          <div className="px-1 pb-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            {updateAction}
          </div>
        )}

        {WORKSPACES_ENABLED && isSignedIn && (
          <button
            onClick={() => (activeWorkspace ? setInviteOpen(true) : setCreateWorkspaceOpen(true))}
            aria-label={
              activeWorkspace ? t("sidebar.inviteTeammate") : t("sidebar.createWorkspace")
            }
            className={rowButtonClass}
          >
            <UserPlus size={15} className={rowIconClass} />
            <span className={rowLabelClass}>
              {activeWorkspace ? t("sidebar.inviteTeammate") : t("sidebar.createWorkspace")}
            </span>
          </button>
        )}

        <SupportDropdown
          trigger={
            <button aria-label={t("sidebar.support")} className={rowButtonClass}>
              <HelpCircle size={15} className={rowIconClass} />
              <span className={rowLabelClass}>{t("sidebar.support")}</span>
            </button>
          }
        />

        <div className="mx-1 h-px bg-border/10 dark:bg-white/6 my-1.5!" />

        <div className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md">
          {userImage ? (
            <img src={userImage} alt="" className="w-6 h-6 rounded-full shrink-0 object-cover" />
          ) : (
            <UserCircle size={18} className="shrink-0 text-foreground/50 dark:text-foreground/45" />
          )}
          <div className="flex-1 min-w-0">
            {isSignedIn && (userName || userEmail) ? (
              <>
                <p className="text-xs text-foreground/80 dark:text-foreground/80 truncate leading-tight">
                  {userName || t("sidebar.defaultUser")}
                </p>
                {userEmail && (
                  <p className="text-xs text-foreground/55 dark:text-foreground/55 truncate leading-tight">
                    {userEmail}
                  </p>
                )}
              </>
            ) : authLoaded && !isSignedIn ? (
              <p className="text-xs text-foreground/45 dark:text-foreground/55">
                {t("sidebar.notSignedIn")}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {WORKSPACES_ENABLED && activeWorkspace && (
        <InviteTeammateDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
        />
      )}
      {WORKSPACES_ENABLED && (
        <CreateWorkspaceDialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} />
      )}
    </div>
  );
}
