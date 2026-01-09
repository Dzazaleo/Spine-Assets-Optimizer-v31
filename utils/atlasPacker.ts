
import { OptimizationTask, AtlasPage, PackedRect } from '../types';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ----------------------------------------------------------------------
// TYPESCRIPT IMPLEMENTATION (Main Thread Usage)
// ----------------------------------------------------------------------

class MaxRectsPacker {
  width: number;
  height: number;
  padding: number;
  freeRects: Rect[];
  packedRects: PackedRect[];

  constructor(width: number, height: number, padding: number) {
    this.width = width;
    this.height = height;
    this.padding = padding;
    this.freeRects = [{ x: 0, y: 0, width: width, height: height }];
    this.packedRects = [];
  }

  insert(task: OptimizationTask): PackedRect | null {
    const requiredW = task.targetWidth + this.padding;
    const requiredH = task.targetHeight + this.padding;

    const bestNode = this.findBestNode(requiredW, requiredH);
    
    if (bestNode.score === Number.MAX_VALUE) {
      return null;
    }

    const newRect: PackedRect = {
      x: bestNode.rect.x,
      y: bestNode.rect.y,
      w: task.targetWidth,
      h: task.targetHeight,
      task: task
    };

    this.placeRect(bestNode.rect);
    return newRect;
  }

  private findBestNode(w: number, h: number): { score: number, rect: Rect } {
    let bestScore = Number.MAX_VALUE;
    let bestRect: Rect = { x: 0, y: 0, width: 0, height: 0 };

    for (const free of this.freeRects) {
      if (free.width >= w && free.height >= h) {
        // Best Short Side Fit
        const leftoverHoriz = Math.abs(free.width - w);
        const leftoverVert = Math.abs(free.height - h);
        const shortSideFit = Math.min(leftoverHoriz, leftoverVert);
        
        if (shortSideFit < bestScore) {
          bestScore = shortSideFit;
          bestRect = { x: free.x, y: free.y, width: w, height: h };
        }
      }
    }

    return { score: bestScore, rect: bestRect };
  }

  private placeRect(rect: Rect) {
    for (let i = 0; i < this.freeRects.length; i++) {
      if (this.splitFreeNode(this.freeRects[i], rect)) {
        this.freeRects.splice(i, 1);
        i--;
      }
    }
    // Pruning redundant rectangles is critical for performance at 4096px+
    this.pruneFreeList();
  }

  private pruneFreeList() {
    for (let i = 0; i < this.freeRects.length; i++) {
      for (let j = i + 1; j < this.freeRects.length; j++) {
        const rect1 = this.freeRects[i];
        const rect2 = this.freeRects[j];

        if (this.isContained(rect1, rect2)) {
          this.freeRects.splice(i, 1);
          i--;
          break;
        }
        if (this.isContained(rect2, rect1)) {
          this.freeRects.splice(j, 1);
          j--;
        }
      }
    }
  }

  private isContained(a: Rect, b: Rect): boolean {
    return a.x >= b.x && a.y >= b.y && 
           a.x + a.width <= b.x + b.width && 
           a.y + a.height <= b.y + b.height;
  }

  private splitFreeNode(freeNode: Rect, usedNode: Rect): boolean {
    if (usedNode.x >= freeNode.x + freeNode.width ||
        usedNode.x + usedNode.width <= freeNode.x ||
        usedNode.y >= freeNode.y + freeNode.height ||
        usedNode.y + usedNode.height <= freeNode.y) {
      return false;
    }

    if (usedNode.x < freeNode.x + freeNode.width && usedNode.x + usedNode.width > freeNode.x) {
      if (usedNode.y > freeNode.y && usedNode.y < freeNode.y + freeNode.height) {
        this.freeRects.push({
          x: freeNode.x,
          y: freeNode.y,
          width: freeNode.width,
          height: usedNode.y - freeNode.y
        });
      }

      if (usedNode.y + usedNode.height < freeNode.y + freeNode.height) {
        this.freeRects.push({
          x: freeNode.x,
          y: usedNode.y + usedNode.height,
          width: freeNode.width,
          height: freeNode.y + freeNode.height - (usedNode.y + usedNode.height)
        });
      }
    }

    if (usedNode.y < freeNode.y + freeNode.height && usedNode.y + usedNode.height > freeNode.y) {
      if (usedNode.x > freeNode.x && usedNode.x < freeNode.x + freeNode.width) {
        this.freeRects.push({
          x: freeNode.x,
          y: freeNode.y,
          width: usedNode.x - freeNode.x,
          height: freeNode.height
        });
      }

      if (usedNode.x + usedNode.width < freeNode.x + freeNode.width) {
        this.freeRects.push({
          x: usedNode.x + usedNode.width,
          y: freeNode.y,
          width: freeNode.x + freeNode.width - (usedNode.x + usedNode.width),
          height: freeNode.height
        });
      }
    }

    return true;
  }
}

export function packAtlases(tasks: OptimizationTask[], maxSize: number = 2048, padding: number = 2): AtlasPage[] {
  const sortedTasks = [...tasks].sort((a, b) => b.targetHeight - a.targetHeight);
  const pages: AtlasPage[] = [];
  let currentPageIndex = 0;
  const remaining = [...sortedTasks];

  while (remaining.length > 0) {
    const packer = new MaxRectsPacker(maxSize, maxSize, padding);
    const pageItems: PackedRect[] = [];
    const didntFit: OptimizationTask[] = [];

    for (const task of remaining) {
      if (task.targetWidth > maxSize || task.targetHeight > maxSize) {
         continue; 
      }

      const rect = packer.insert(task);
      if (rect) {
        pageItems.push(rect);
      } else {
        didntFit.push(task);
      }
    }

    let usedArea = 0;
    pageItems.forEach(p => usedArea += (p.w * p.h));
    const totalArea = maxSize * maxSize;
    const efficiency = (usedArea / totalArea) * 100;

    pages.push({
      id: currentPageIndex++,
      width: maxSize,
      height: maxSize,
      items: pageItems,
      efficiency
    });

    if (pageItems.length === 0 && didntFit.length === remaining.length) {
      break;
    }

    remaining.splice(0, remaining.length, ...didntFit);
  }

  return pages;
}


// ----------------------------------------------------------------------
// INLINE WORKER SOURCE CODE (Blob Usage)
// ----------------------------------------------------------------------

export const PACKER_WORKER_CODE = `
class MaxRectsPacker {
    constructor(width, height, padding) {
        this.width = width;
        this.height = height;
        this.padding = padding;
        this.freeRects = [{ x: 0, y: 0, width: width, height: height }];
        this.packedRects = [];
    }

    insert(task) {
        const requiredW = task.targetWidth + this.padding;
        const requiredH = task.targetHeight + this.padding;
        const bestNode = this.findBestNode(requiredW, requiredH);
        
        if (bestNode.score === Number.MAX_VALUE) return null;
        
        const newRect = {
            x: bestNode.rect.x,
            y: bestNode.rect.y,
            w: task.targetWidth,
            h: task.targetHeight,
            task: task
        };
        
        this.placeRect(bestNode.rect);
        return newRect;
    }

    findBestNode(w, h) {
        let bestScore = Number.MAX_VALUE;
        let bestRect = { x: 0, y: 0, width: 0, height: 0 };
        
        for (const free of this.freeRects) {
            if (free.width >= w && free.height >= h) {
                const leftoverHoriz = Math.abs(free.width - w);
                const leftoverVert = Math.abs(free.height - h);
                const shortSideFit = Math.min(leftoverHoriz, leftoverVert);
                
                if (shortSideFit < bestScore) {
                    bestScore = shortSideFit;
                    bestRect = { x: free.x, y: free.y, width: w, height: h };
                }
            }
        }
        return { score: bestScore, rect: bestRect };
    }

    placeRect(rect) {
        for (let i = 0; i < this.freeRects.length; i++) {
            if (this.splitFreeNode(this.freeRects[i], rect)) {
                this.freeRects.splice(i, 1);
                i--;
            }
        }
        this.pruneFreeList();
    }

    pruneFreeList() {
        for (let i = 0; i < this.freeRects.length; i++) {
            for (let j = i + 1; j < this.freeRects.length; j++) {
                const rect1 = this.freeRects[i];
                const rect2 = this.freeRects[j];
                if (this.isContained(rect1, rect2)) {
                    this.freeRects.splice(i, 1);
                    i--;
                    break;
                }
                if (this.isContained(rect2, rect1)) {
                    this.freeRects.splice(j, 1);
                    j--;
                }
            }
        }
    }

    isContained(a, b) {
        return a.x >= b.x && a.y >= b.y &&
               a.x + a.width <= b.x + b.width &&
               a.y + a.height <= b.y + b.height;
    }

    splitFreeNode(freeNode, usedNode) {
        if (usedNode.x >= freeNode.x + freeNode.width ||
            usedNode.x + usedNode.width <= freeNode.x ||
            usedNode.y >= freeNode.y + freeNode.height ||
            usedNode.y + usedNode.height <= freeNode.y) {
            return false;
        }
        
        if (usedNode.x < freeNode.x + freeNode.width && usedNode.x + usedNode.width > freeNode.x) {
            if (usedNode.y > freeNode.y && usedNode.y < freeNode.y + freeNode.height) {
                this.freeRects.push({
                    x: freeNode.x,
                    y: freeNode.y,
                    width: freeNode.width,
                    height: usedNode.y - freeNode.y
                });
            }
            if (usedNode.y + usedNode.height < freeNode.y + freeNode.height) {
                this.freeRects.push({
                    x: freeNode.x,
                    y: usedNode.y + usedNode.height,
                    width: freeNode.width,
                    height: freeNode.y + freeNode.height - (usedNode.y + usedNode.height)
                });
            }
        }
        
        if (usedNode.y < freeNode.y + freeNode.height && usedNode.y + usedNode.height > freeNode.y) {
            if (usedNode.x > freeNode.x && usedNode.x < freeNode.x + freeNode.width) {
                this.freeRects.push({
                    x: freeNode.x,
                    y: freeNode.y,
                    width: usedNode.x - freeNode.x,
                    height: freeNode.height
                });
            }
            if (usedNode.x + usedNode.width < freeNode.x + freeNode.width) {
                this.freeRects.push({
                    x: usedNode.x + usedNode.width,
                    y: freeNode.y,
                    width: freeNode.x + freeNode.width - (usedNode.x + usedNode.width),
                    height: freeNode.height
                });
            }
        }
        return true;
    }
}

function packAtlases(tasks, maxSize, padding) {
    const sortedTasks = [...tasks].sort((a, b) => b.targetHeight - a.targetHeight);
    const pages = [];
    let currentPageIndex = 0;
    const remaining = [...sortedTasks];
    
    while (remaining.length > 0) {
        const packer = new MaxRectsPacker(maxSize, maxSize, padding);
        const pageItems = [];
        const didntFit = [];
        
        for (const task of remaining) {
            if (task.targetWidth > maxSize || task.targetHeight > maxSize) continue;
            
            const rect = packer.insert(task);
            if (rect) {
                pageItems.push(rect);
            } else {
                didntFit.push(task);
            }
        }
        
        let usedArea = 0;
        pageItems.forEach(p => usedArea += (p.w * p.h));
        const totalArea = maxSize * maxSize;
        const efficiency = (usedArea / totalArea) * 100;
        
        pages.push({
            id: currentPageIndex++,
            width: maxSize,
            height: maxSize,
            items: pageItems,
            efficiency
        });
        
        if (pageItems.length === 0 && didntFit.length === remaining.length) break;
        remaining.splice(0, remaining.length, ...didntFit);
    }
    return pages;
}

self.onmessage = (e) => {
    const { tasks, maxSize, padding } = e.data;
    try {
        const pages = packAtlases(tasks, maxSize, padding);
        self.postMessage({ success: true, pages });
    } catch (err) {
        self.postMessage({ success: false, error: err.toString() });
    }
};
`;
