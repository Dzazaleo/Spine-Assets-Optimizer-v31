
import React, { useEffect, useRef, useState, useMemo } from 'react';
import { AtlasPage, OptimizationTask, PackedRect } from '../types';
import { PACKER_WORKER_CODE } from '../utils/atlasPacker';
import { X, Map as MapIcon, ChevronLeft, ChevronRight, Layers, Box, AlertTriangle, Maximize2, Minimize2, Loader2 } from 'lucide-react';
import clsx from 'clsx';

interface AtlasPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: OptimizationTask[];
  missingImageCount: number;
}

export const AtlasPreviewModal: React.FC<AtlasPreviewModalProps> = ({
  isOpen,
  onClose,
  tasks,
  missingImageCount
}) => {
  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  const [pages, setPages] = useState<AtlasPage[]>([]);
  const [isOptimized, setIsOptimized] = useState(true);
  const [maxSize, setMaxSize] = useState(2048);
  
  // High-Performance Bitmap Cache
  const [bitmapCache, setBitmapCache] = useState<Map<string, ImageBitmap>>(new Map());
  const [isCacheReady, setIsCacheReady] = useState(false);
  const [isCalculating, setIsCalculating] = useState(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const renderRequestId = useRef<number | null>(null);
  
  const [rendering, setRendering] = useState(false);
  const [hoveredRect, setHoveredRect] = useState<PackedRect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{x: number, y: number} | null>(null);

  // Identify assets that are too large for the selected atlas size
  const oversizedAssets = useMemo(() => {
    return tasks.filter(t => {
        const w = isOptimized ? t.targetWidth : t.originalWidth;
        const h = isOptimized ? t.targetHeight : t.originalHeight;
        return w > maxSize || h > maxSize;
    });
  }, [tasks, maxSize, isOptimized]);

  // 1. ImageBitmap Lifecycle & Parallel Decoding
  useEffect(() => {
    if (!isOpen || tasks.length === 0) {
        setIsCacheReady(false);
        return;
    }

    let isActive = true;
    const localCache = new Map<string, ImageBitmap>();

    const decodeImages = async () => {
        setRendering(true);
        setIsCacheReady(false);

        try {
            await Promise.all(tasks.map(async (task) => {
                try {
                    const bmp = await createImageBitmap(task.blob);
                    if (isActive) {
                        localCache.set(task.relativePath, bmp);
                    } else {
                        bmp.close();
                    }
                } catch (err) {
                    console.error(`Failed to decode bitmap for ${task.fileName}`, err);
                }
            }));

            if (isActive) {
                setBitmapCache(localCache);
                setIsCacheReady(true);
                setRendering(false);
            }
        } catch (e) {
            console.error("Batch decoding error", e);
            setRendering(false);
        }
    };

    decodeImages();

    return () => {
        isActive = false;
        localCache.forEach(bmp => bmp.close());
        setBitmapCache(new Map());
        setIsCacheReady(false);
    };
  }, [isOpen, tasks]);

  // 2. Web Worker Packing Logic (Inline Blob Worker)
  useEffect(() => {
    if (!isOpen || tasks.length === 0) {
        setPages([]);
        return;
    }
    
    setIsCalculating(true);
    setPages([]); // Clear current view while calculating

    // Create Inline Worker from String Constant
    const blob = new Blob([PACKER_WORKER_CODE], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    // Prepare tasks for worker:
    // 1. Map dimensions based on isOptimized toggle
    // 2. Strip 'blob' to make the message lightweight (structure cloning Blobs is fast but unnecessary here)
    // 3. Add an index to map back results
    const packerTasks = tasks.map((t, i) => ({
        ...t,
        targetWidth: isOptimized ? t.targetWidth : t.originalWidth,
        targetHeight: isOptimized ? t.targetHeight : t.originalHeight,
        blob: undefined, // Strip blob
        _originalIndex: i // Track original index
    }));

    worker.postMessage({
        tasks: packerTasks,
        maxSize: maxSize,
        padding: 2
    });

    worker.onmessage = (e) => {
        const { success, pages: resultPages, error } = e.data;
        
        if (success) {
            // Rehydrate tasks in the result pages
            // The worker returns PackedRects with the "stripped" task. 
            // We need to replace that with the full task reference from our scope.
            const rehydratedPages = resultPages.map((page: any) => ({
                ...page,
                items: page.items.map((item: any) => ({
                    ...item,
                    task: tasks[item.task._originalIndex]
                }))
            }));

            setPages(rehydratedPages);
            setCurrentPageIdx(0);
        } else {
            console.error("Worker Packing Error:", error);
        }
        
        setIsCalculating(false);
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
    };

    worker.onerror = (e) => {
        console.error("Worker Error:", e);
        setIsCalculating(false);
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
    };

    return () => {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
    };
  }, [isOpen, tasks, isOptimized, maxSize]);

  // 3. Batched Drawing Loop (requestAnimationFrame)
  useEffect(() => {
    // Only draw if we have pages and are done calculating layout
    if (!isOpen || !isCacheReady || isCalculating || !pages[currentPageIdx] || !canvasRef.current) return;
    
    const page = pages[currentPageIdx];
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    
    if (!ctx) return;

    if (renderRequestId.current) {
        cancelAnimationFrame(renderRequestId.current);
    }

    setRendering(true);
    
    // Reset Canvas
    ctx.fillStyle = '#1e1e23';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);

    const items = page.items;
    const totalItems = items.length;
    const BATCH_SIZE = totalItems > 200 ? 50 : totalItems; 
    let currentIndex = 0;

    const renderBatch = () => {
        const end = Math.min(currentIndex + BATCH_SIZE, totalItems);

        for (let i = currentIndex; i < end; i++) {
            const item = items[i];
            const bmp = bitmapCache.get(item.task.relativePath);

            if (bmp) {
                ctx.drawImage(bmp, item.x, item.y, item.w, item.h);
                ctx.strokeStyle = 'rgba(100, 255, 100, 0.3)';
                ctx.lineWidth = 1;
                ctx.strokeRect(item.x, item.y, item.w, item.h);
            } else {
                ctx.fillStyle = '#333';
                ctx.fillRect(item.x, item.y, item.w, item.h);
                ctx.strokeStyle = 'red';
                ctx.strokeRect(item.x, item.y, item.w, item.h);
            }
        }

        currentIndex = end;

        if (currentIndex < totalItems) {
            renderRequestId.current = requestAnimationFrame(renderBatch);
        } else {
            setRendering(false);
            renderRequestId.current = null;
        }
    };

    renderRequestId.current = requestAnimationFrame(renderBatch);

    return () => {
        if (renderRequestId.current) cancelAnimationFrame(renderRequestId.current);
    };
  }, [isOpen, currentPageIdx, pages, maxSize, isCacheReady, bitmapCache, isCalculating]);

  // Render Highlight Overlay
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (hoveredRect) {
        ctx.shadowColor = '#ff5c5c';
        ctx.shadowBlur = 20;
        ctx.strokeStyle = '#ff5c5c';
        ctx.lineWidth = 6;
        ctx.strokeRect(hoveredRect.x, hoveredRect.y, hoveredRect.w, hoveredRect.h);
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255, 92, 92, 0.15)';
        ctx.fillRect(hoveredRect.x, hoveredRect.y, hoveredRect.w, hoveredRect.h);
    }
  }, [hoveredRect]);

  const handleMouseMove = (e: React.MouseEvent) => {
    const activePage = pages[currentPageIdx];
    if (!activePage || !overlayCanvasRef.current || isCalculating) return;
    
    const rect = overlayCanvasRef.current.getBoundingClientRect();
    
    const scaleX = maxSize / rect.width;
    const scaleY = maxSize / rect.height;
    
    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top) * scaleY;
    
    let found: PackedRect | undefined;
    for (let i = activePage.items.length - 1; i >= 0; i--) {
        const item = activePage.items[i];
        if (canvasX >= item.x && canvasX <= item.x + item.w &&
            canvasY >= item.y && canvasY <= item.y + item.h) {
            found = item;
            break;
        }
    }
    
    setHoveredRect(found || null);

    if (found && containerRef.current) {
        const containerRect = containerRef.current.getBoundingClientRect();
        const cursorX = e.clientX - containerRect.left;
        const cursorY = e.clientY - containerRect.top;
        const containerW = containerRect.width;
        const containerH = containerRect.height;

        let tooltipW = 220; 
        let tooltipH = 120;
        
        if (tooltipRef.current) {
            const tRect = tooltipRef.current.getBoundingClientRect();
            tooltipW = tRect.width;
            tooltipH = tRect.height;
        }

        const margin = 20;
        let targetX = cursorX + margin;
        let targetY = cursorY + margin;

        if (targetX + tooltipW > containerW) targetX = cursorX - tooltipW - margin;
        if (targetY + tooltipH > containerH) targetY = cursorY - tooltipH - margin;

        setTooltipPos({ x: Math.round(targetX), y: Math.round(targetY) });
    } else {
        setTooltipPos(null);
    }
  };

  const handleMouseLeave = () => {
    setHoveredRect(null);
    setTooltipPos(null);
  };

  if (!isOpen) return null;

  const activePage = pages[currentPageIdx];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="flex flex-col w-full max-w-5xl h-[90vh] overflow-hidden border border-gray-700 rounded-xl bg-spine-dark shadow-2xl">
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-800/50">
          <div className="flex items-center gap-3">
            <MapIcon className="text-spine-accent" size={24} />
            <div>
               <h3 className="text-xl font-semibold text-white">Atlas Preview</h3>
               <p className="text-xs text-gray-400">
                  Visual estimation of packed textures ({maxSize}x{maxSize}).
               </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          
          {/* Controls / Stats Sidebar */}
          <div className="w-full md:w-64 p-4 border-r border-gray-700 bg-gray-900/50 flex flex-col gap-6 overflow-y-auto shrink-0">
             
             {/* Missing Assets Warning */}
             {missingImageCount > 0 && (
                <div className="p-3 bg-red-900/20 border border-red-500/30 rounded-lg flex flex-col gap-2">
                   <div className="flex items-center gap-2 text-red-400">
                      <AlertTriangle size={16} />
                      <span className="text-xs font-bold uppercase tracking-wider">Warning</span>
                   </div>
                   <p className="text-xs text-red-200/80 leading-relaxed">
                      <span className="font-bold text-white">{missingImageCount} missing assets</span> are excluded from this preview.
                   </p>
                </div>
             )}

             {/* Oversized Assets Warning */}
             {oversizedAssets.length > 0 && (
                <div className="p-3 bg-amber-900/20 border border-amber-500/30 rounded-lg flex flex-col gap-2">
                   <div className="flex items-center gap-2 text-amber-400">
                      <AlertTriangle size={16} />
                      <span className="text-xs font-bold uppercase tracking-wider">Oversized</span>
                   </div>
                   <p className="text-xs text-amber-200/80 leading-relaxed">
                      <span className="font-bold text-white">{oversizedAssets.length} assets</span> exceed {maxSize}px and were excluded from packing.
                   </p>
                   <div className="max-h-24 overflow-y-auto space-y-1 mt-1 pr-1 scrollbar-hide">
                      {oversizedAssets.map((t, i) => (
                           <div key={i} className="text-[10px] text-amber-300/70 truncate font-mono bg-black/20 px-1.5 py-0.5 rounded" title={t.fileName}>
                              {t.fileName} ({isOptimized ? t.targetWidth : t.originalWidth}x{isOptimized ? t.targetHeight : t.originalHeight})
                           </div>
                      ))}
                   </div>
                </div>
             )}

             {/* View Toggle */}
             <div className="p-4 bg-gray-800 rounded-lg border border-gray-700 flex flex-col gap-3">
                <span className="text-xs font-bold text-gray-400 uppercase">View Mode</span>
                <div className="flex bg-gray-900 rounded p-1 border border-gray-700">
                    <button 
                       className={clsx("flex-1 py-1.5 text-xs font-medium rounded transition-colors", !isOptimized ? "bg-gray-700 text-white shadow" : "text-gray-400 hover:text-gray-300")}
                       onClick={() => setIsOptimized(false)}
                       disabled={isCalculating}
                    >
                       Original
                    </button>
                    <button 
                       className={clsx("flex-1 py-1.5 text-xs font-medium rounded transition-colors", isOptimized ? "bg-spine-accent text-white shadow" : "text-gray-400 hover:text-gray-300")}
                       onClick={() => setIsOptimized(true)}
                       disabled={isCalculating}
                    >
                       Optimized
                    </button>
                </div>
                <p className="text-[10px] text-gray-500">
                    {isOptimized ? "Showing calculated max render sizes." : "Showing original source dimensions."}
                </p>
             </div>

             {/* Resolution Toggle */}
             <div className="p-4 bg-gray-800 rounded-lg border border-gray-700 flex flex-col gap-3">
                <span className="text-xs font-bold text-gray-400 uppercase">Atlas Resolution</span>
                <div className="flex bg-gray-900 rounded p-1 border border-gray-700">
                    <button 
                       className={clsx("flex-1 py-1.5 text-xs font-medium rounded transition-colors", maxSize === 2048 ? "bg-spine-accent text-white shadow" : "text-gray-400 hover:text-gray-300")}
                       onClick={() => setMaxSize(2048)}
                       disabled={isCalculating}
                    >
                       2048px
                    </button>
                    <button 
                       className={clsx("flex-1 py-1.5 text-xs font-medium rounded transition-colors", maxSize === 4096 ? "bg-spine-accent text-white shadow" : "text-gray-400 hover:text-gray-300")}
                       onClick={() => setMaxSize(4096)}
                       disabled={isCalculating}
                    >
                       4096px
                    </button>
                </div>
             </div>

             {/* Pagination */}
             <div className="flex flex-col gap-2 p-4 bg-gray-800 rounded-lg border border-gray-700">
                <span className="text-xs font-bold text-gray-400 uppercase">Atlas Page</span>
                <div className="flex items-center justify-between">
                   <button 
                     onClick={() => setCurrentPageIdx(p => Math.max(0, p - 1))}
                     disabled={currentPageIdx === 0 || isCalculating}
                     className="p-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30"
                   >
                     <ChevronLeft size={20} />
                   </button>
                   <span className="font-mono font-bold text-lg">
                     {pages.length > 0 ? currentPageIdx + 1 : 0} <span className="text-gray-500 text-sm">/ {pages.length}</span>
                   </span>
                   <button 
                     onClick={() => setCurrentPageIdx(p => Math.min(pages.length - 1, p + 1))}
                     disabled={currentPageIdx === pages.length - 1 || isCalculating}
                     className="p-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30"
                   >
                     <ChevronRight size={20} />
                   </button>
                </div>
             </div>

             {/* Stats */}
             <div className="space-y-4">
                <div className="flex items-start gap-3 p-3 bg-blue-900/20 rounded border border-blue-800/30">
                  <Layers size={18} className="text-blue-400 mt-1" />
                  <div>
                    <span className="block text-xs text-blue-300 font-bold uppercase">Total Atlases</span>
                    <span className="text-xl font-bold text-white">{pages.length}</span>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 bg-green-900/20 rounded border border-green-800/30">
                  <Box size={18} className="text-green-400 mt-1" />
                  <div>
                    <span className="block text-xs text-green-300 font-bold uppercase">Efficiency (Page {pages.length > 0 ? currentPageIdx + 1 : 0})</span>
                    <span className="text-xl font-bold text-white">{activePage?.efficiency.toFixed(1) || 0}%</span>
                    <span className="block text-xs text-green-400/60 mt-1">
                      {(100 - (activePage?.efficiency || 0)).toFixed(1)}% Empty Space
                    </span>
                  </div>
                </div>
             </div>

             <div className="mt-auto pt-4 text-[10px] text-gray-500">
               * Preview assumes 2px padding and no rotation. Actual export engine may vary slightly.
             </div>
          </div>

          {/* Canvas Area */}
          <div className="flex-1 bg-black/50 relative flex items-center justify-center p-4 overflow-hidden">
             
             {/* Loading / Rendering Indicator */}
             {(!isCacheReady || isCalculating || rendering) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-black/60 backdrop-blur-sm pointer-events-none">
                   <Loader2 size={32} className="text-spine-accent animate-spin mb-2" />
                   <span className="text-spine-accent font-bold animate-pulse text-sm">
                       {!isCacheReady ? "Decoding Images..." : isCalculating ? "Calculating Layout..." : "Rendering Atlas..."}
                   </span>
                </div>
             )}
             
             {/* Canvas Container */}
             <div 
                ref={containerRef}
                className="relative shadow-2xl border border-gray-800 bg-[#1e1e23] max-w-full max-h-full aspect-square"
             >
                {/* Main Render Canvas */}
                <canvas 
                  ref={canvasRef}
                  width={maxSize}
                  height={maxSize}
                  className="block w-full h-full object-contain"
                  style={{ maxHeight: 'calc(90vh - 150px)' }}
                />
                
                {/* Interactive Overlay Canvas */}
                <canvas
                  ref={overlayCanvasRef}
                  width={maxSize}
                  height={maxSize}
                  className="absolute inset-0 w-full h-full object-contain cursor-crosshair touch-none"
                  onMouseMove={handleMouseMove}
                  onMouseLeave={handleMouseLeave}
                />

                {/* Floating Tooltip */}
                {hoveredRect && tooltipPos && !isCalculating && (
                    <div 
                        ref={tooltipRef}
                        className="absolute z-50 bg-gray-900/95 border border-spine-accent p-3 rounded-lg shadow-2xl pointer-events-none backdrop-blur-md min-w-[220px] transition-transform duration-100 ease-out will-change-transform antialiased"
                        style={{ 
                            top: 0,
                            left: 0,
                            transform: `translate3d(${tooltipPos.x}px, ${tooltipPos.y}px, 0)`,
                            backfaceVisibility: 'hidden',
                            transformStyle: 'preserve-3d',
                            textRendering: 'optimizeLegibility'
                        }}
                    >
                        <div className="text-xs font-bold text-white mb-1 truncate max-w-[250px]">
                            {hoveredRect.task.fileName}
                        </div>
                        <div className="h-px bg-gray-700 my-2"></div>
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-[10px]">
                                <span className="text-gray-400">Current Size:</span>
                                <span className="font-mono text-spine-accent font-bold">
                                    {hoveredRect.w} x {hoveredRect.h}
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-[10px]">
                                <span className="text-gray-400">Original Size:</span>
                                <span className="font-mono text-gray-300">
                                    {hoveredRect.task.originalWidth} x {hoveredRect.task.originalHeight}
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-[10px]">
                                <span className="text-gray-400">Scale Factor:</span>
                                <div className="flex items-center gap-1">
                                    {hoveredRect.w > hoveredRect.task.originalWidth ? (
                                        <Maximize2 size={10} className="text-yellow-400" />
                                    ) : (
                                        <Minimize2 size={10} className="text-green-400" />
                                    )}
                                    <span className={clsx("font-mono font-bold", 
                                        hoveredRect.w > hoveredRect.task.originalWidth ? "text-yellow-400" : "text-green-400"
                                    )}>
                                        {Math.round((hoveredRect.w / hoveredRect.task.originalWidth) * 100)}%
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
             </div>
          </div>
        </div>

      </div>
    </div>
  );
};
