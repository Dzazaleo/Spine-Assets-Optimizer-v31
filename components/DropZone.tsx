
import React, { useCallback, useState } from 'react';
import { UploadCloud, FileJson, Image as ImageIcon, CheckCircle, Trash2, Map } from 'lucide-react';
import { processDropItems, enrichAssetsWithDimensions } from '../utils/fileHelpers';
import { FileAsset } from '../types';
import clsx from 'clsx';

interface DropZoneProps {
  onFilesLoaded: (files: FileAsset[]) => void;
  onClear?: () => void;
  stats?: {
    json?: string; // Can be filename or "X Skeletons"
    images?: number;
    atlasCount?: number;
  };
}

export const DropZone: React.FC<DropZoneProps> = ({ 
  onFilesLoaded,
  onClear,
  stats
}) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.items) {
      const assets = await processDropItems(e.dataTransfer.items);
      onFilesLoaded(assets);
    } else if (e.dataTransfer.files) {
      let assets: FileAsset[] = Array.from(e.dataTransfer.files).map((f: File) => ({
        file: f,
        path: f.name 
      }));
      assets = await enrichAssetsWithDimensions(assets);
      onFilesLoaded(assets);
    }
  }, [onFilesLoaded]);

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      let assets: FileAsset[] = Array.from(e.target.files).map((f: File) => ({
        file: f,
        path: (f as any).webkitRelativePath || f.name
      }));
      assets = await enrichAssetsWithDimensions(assets);
      onFilesLoaded(assets);
      // Reset input so same file can be selected again if needed after clear
      e.target.value = ''; 
    }
  };

  const hasContent = stats?.json || (stats?.images && stats.images > 0) || (stats?.atlasCount && stats.atlasCount > 0);
  const isAtlasMode = (stats?.atlasCount || 0) > 0;
  const imageLabel = isAtlasMode ? "Regions" : "Images";
  
  const borderColor = isDragging 
    ? 'border-spine-accent' 
    : hasContent
      ? 'border-spine-success' 
      : 'border-gray-600';

  const bgColor = isDragging 
    ? 'bg-spine-card/80' 
    : 'bg-spine-card/40';

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={clsx(
        "relative flex flex-col items-center justify-center w-full p-6 transition-all border-2 border-dashed rounded-xl cursor-pointer hover:bg-spine-card/60 group min-h-[160px]",
        borderColor,
        bgColor
      )}
    >
      <input
        type="file"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        onChange={handleFileInput}
        accept=".json,.png,.jpg,.jpeg,.webp,.atlas"
        multiple
      />
      
      <div className="flex flex-col items-center gap-4 text-center pointer-events-none">
        {hasContent ? (
          <div className="flex flex-wrap justify-center gap-6 md:gap-12">
             <div className={clsx("flex flex-col items-center gap-2", stats?.json ? "text-spine-success" : "text-gray-500")}>
                <div className={clsx("p-2 rounded-full", stats?.json ? "bg-spine-success/20" : "bg-gray-800")}>
                   {stats?.json ? <CheckCircle size={20} /> : <FileJson size={20} />}
                </div>
                <span className="text-[10px] font-bold uppercase">{stats?.json ? "JSON Loaded" : "No JSON"}</span>
                {stats?.json && <span className="text-[9px] max-w-[100px] truncate">{stats.json}</span>}
             </div>

             {(stats?.atlasCount || 0) > 0 && (
                <div className="flex flex-col items-center gap-2 text-purple-400 animate-in zoom-in duration-300">
                    <div className="p-2 rounded-full bg-purple-500/20">
                        <Map size={20} />
                    </div>
                    <span className="text-[10px] font-bold uppercase">{stats?.atlasCount} {stats?.atlasCount === 1 ? 'Atlas' : 'Atlases'}</span>
                </div>
             )}

             <div className={clsx("flex flex-col items-center gap-2", (stats?.images || 0) > 0 ? "text-spine-success" : "text-gray-500")}>
                <div className={clsx("p-2 rounded-full", (stats?.images || 0) > 0 ? "bg-spine-success/20" : "bg-gray-800")}>
                   {(stats?.images || 0) > 0 ? <CheckCircle size={20} /> : <ImageIcon size={20} />}
                </div>
                <span className="text-[10px] font-bold uppercase">{(stats?.images || 0)} {imageLabel}</span>
             </div>
          </div>
        ) : (
          <div className="p-4 rounded-full bg-gray-700/50 text-gray-400 group-hover:text-spine-accent group-hover:bg-spine-accent/10 transition-colors">
            <UploadCloud className="w-10 h-10" />
          </div>
        )}
        
        <div className="space-y-1">
          <p className="text-lg font-medium text-gray-200">
            {hasContent ? "Update or Merge Files" : "Drop Spine files here"}
          </p>
          <p className="text-xs text-gray-400">
            Accepts <span className="text-spine-accent">.json</span>, <span className="text-spine-accent">.atlas</span>, and images.
          </p>
        </div>
      </div>

      {/* Clear Assets Button */}
      {hasContent && onClear && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="absolute bottom-3 right-3 z-20 flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold text-red-300 bg-red-950/50 border border-red-900/50 rounded-lg hover:bg-red-900 hover:text-white hover:border-red-500 transition-all shadow-sm"
          title="Clear all assets and reset"
        >
          <Trash2 size={12} />
          Clear Assets
        </button>
      )}
    </div>
  );
};
