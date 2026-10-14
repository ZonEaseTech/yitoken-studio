// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
"use client";

/**
 * ProjectHeader - Top bar showing project name and local workspace
 * Based on CineGen-AI App.tsx auto-save pattern
 */

import { useProjectStore } from "@/stores/project-store";
import { useMediaPanelStore, stages } from "@/stores/media-panel-store";
import { ChevronRight } from "lucide-react";

export function ProjectHeader() {
  const { activeProject } = useProjectStore();
  const { activeStage, activeEpisodeIndex, backToSeries } = useMediaPanelStore();

  // Get current stage info
  const currentStageConfig = stages.find(s => s.id === activeStage);

  return (
    <div className="h-10 bg-[#0f0f0f] border-b border-zinc-800 px-4 flex items-center justify-between shrink-0">
      {/* Left: Project Name + Stage + Episode Breadcrumb */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-white truncate max-w-[200px]">
          {activeProject?.name || "未命名项目"}
        </span>
        {activeEpisodeIndex != null && (
          <>
            <ChevronRight className="h-3 w-3 text-zinc-600" />
            <button
              className="text-xs text-primary hover:text-primary/80 font-medium transition-colors"
              onClick={backToSeries}
              title="返回全剧视图"
            >
              第{activeEpisodeIndex}集
            </button>
          </>
        )}
        {currentStageConfig && (
          <>
            <span className="text-zinc-700">/</span>
            <span className="text-xs text-zinc-500 font-mono">
              {currentStageConfig.phase}
            </span>
            <span className="text-xs text-zinc-400">
              {currentStageConfig.id === 'export' ? '整片与素材导出' : currentStageConfig.label}
            </span>
          </>
        )}
      </div>

      {/* Individual storage operations report their own result; this is not an IO acknowledgement. */}
      <span className="text-[10px] text-zinc-500" title="保存结果请以具体操作提示为准">本地工作区</span>
    </div>
  );
}
