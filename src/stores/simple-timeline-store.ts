// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Simple Timeline Store
 * Single-track timeline for arranging and playing video clips
 * No complex editing - just drag to arrange and play in sequence
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createProjectScopedStorage } from "@/lib/project-storage";
import { useProjectStore } from "@/stores/project-store";
import { nanoid } from "nanoid";

export interface TimelineClip {
  id: string;
  mediaId: string;        // Reference to media store item
  name: string;
  url: string;
  thumbnailUrl?: string;
  duration: number;       // Duration in seconds
  startTime: number;      // Start time on timeline in seconds
}

interface SimpleTimelineStore {
  boundProjectId: string | null;
  loadError: string | null;
  // Clips on the timeline
  clips: TimelineClip[];
  
  // Playback state
  isPlaying: boolean;
  currentTime: number;    // Current playback position in seconds
  totalDuration: number;  // Total timeline duration
  
  // Currently playing clip
  activeClipId: string | null;
  
  // Actions
  addClip: (clip: Omit<TimelineClip, "id" | "startTime">) => void;
  removeClip: (id: string) => void;
  reorderClips: (fromIndex: number, toIndex: number) => void;
  clearTimeline: () => void;
  
  // Playback controls
  play: () => void;
  pause: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setCurrentTime: (time: number) => void;
  
  // Get clip at time
  getClipAtTime: (time: number) => TimelineClip | null;
}

export const useSimpleTimelineStore = create<SimpleTimelineStore>()(
  persist(
    (set, get) => ({
      boundProjectId: null,
      loadError: null,
      clips: [],
      isPlaying: false,
      currentTime: 0,
      totalDuration: 0,
      activeClipId: null,
  
  addClip: (clipData) => {
    if (!get().boundProjectId || get().boundProjectId !== useProjectStore.getState().activeProjectId || get().loadError) return;
    const { clips } = get();
    if (!clipData.url || !Number.isFinite(clipData.duration) || clipData.duration <= 0) return;
    
    // Calculate start time (end of last clip)
    const startTime = clips.reduce((acc, clip) => acc + clip.duration, 0);
    
    const newClip: TimelineClip = {
      ...clipData,
      id: nanoid(),
      startTime,
    };
    
    const newClips = [...clips, newClip];
    const totalDuration = newClips.reduce((acc, clip) => acc + clip.duration, 0);
    
    set({ clips: newClips, totalDuration });
  },
  
  removeClip: (id) => {
    if (!get().boundProjectId || get().boundProjectId !== useProjectStore.getState().activeProjectId || get().loadError) return;
    const { clips } = get();
    const newClips = clips.filter(c => c.id !== id);
    
    // Recalculate start times
    let currentStart = 0;
    const recalculatedClips = newClips.map(clip => {
      const updated = { ...clip, startTime: currentStart };
      currentStart += clip.duration;
      return updated;
    });
    
    const totalDuration = recalculatedClips.reduce((acc, clip) => acc + clip.duration, 0);
    
    set({ clips: recalculatedClips, totalDuration });
  },
  
  reorderClips: (fromIndex, toIndex) => {
    if (!get().boundProjectId || get().boundProjectId !== useProjectStore.getState().activeProjectId || get().loadError) return;
    const { clips } = get();
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || fromIndex >= clips.length || toIndex >= clips.length) return;
    const newClips = [...clips];
    const [removed] = newClips.splice(fromIndex, 1);
    newClips.splice(toIndex, 0, removed);
    
    // Recalculate start times
    let currentStart = 0;
    const recalculatedClips = newClips.map(clip => {
      const updated = { ...clip, startTime: currentStart };
      currentStart += clip.duration;
      return updated;
    });
    
    set({ clips: recalculatedClips });
  },
  
  clearTimeline: () => {
    if (!get().boundProjectId || get().boundProjectId !== useProjectStore.getState().activeProjectId || get().loadError) return;
    set({ 
      clips: [], 
      currentTime: 0, 
      totalDuration: 0, 
      isPlaying: false,
      activeClipId: null,
    });
  },
  
  play: () => set({ isPlaying: true }),
  
  pause: () => set({ isPlaying: false }),
  
  stop: () => set({ isPlaying: false, currentTime: 0, activeClipId: null }),
  
  seek: (time) => {
    const { totalDuration } = get();
    const clampedTime = Math.max(0, Math.min(time, totalDuration));
    set({ currentTime: clampedTime });
  },
  
  setCurrentTime: (time) => {
    const clip = get().getClipAtTime(time);
    set({ currentTime: time, activeClipId: clip?.id || null });
  },
  
  getClipAtTime: (time) => {
    const { clips } = get();
    for (const clip of clips) {
      if (time >= clip.startTime && time < clip.startTime + clip.duration) {
        return clip;
      }
    }
    return null;
  },
    }),
    {
      name: 'moyin-timeline-store',
      storage: createJSONStorage(() => createProjectScopedStorage('timeline')),
      partialize: (state) => ({
        boundProjectId: state.boundProjectId,
        loadError: state.loadError,
        // Only persist clips, not playback state
        clips: state.clips,
        totalDuration: state.totalDuration,
      }),
      merge: (persisted: any, current: any) => {
        const pid = useProjectStore.getState().activeProjectId;
        const owned = persisted?.boundProjectId === pid;
        const clips = owned && Array.isArray(persisted.clips) ? persisted.clips : [];
        let startTime = 0;
        const normalized = clips.map((clip: TimelineClip) => {
          const duration = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : 5;
          const result = { ...clip, duration, startTime };
          startTime += duration;
          return result;
        });
        return {
          ...current, boundProjectId: pid, clips: normalized, totalDuration: startTime,
          loadError: owned ? persisted.loadError ?? null : '时间线尚未加载完成，请重新打开项目',
          isPlaying: false, currentTime: 0, activeClipId: null,
        };
      },
    }
  )
);

// Helper: Format time as MM:SS
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
