// src/modules/projects/ui/components/fragment-web-updated.tsx
"use client";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Fragment } from "@/generated/prisma";
import { ExternalLinkIcon, RefreshCcwIcon, AlertCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTRPC } from "@/trpc/client";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface Props {
  data: Fragment;
}

export function FragmentWeb({ data }: Props) {
  const trpc = useTRPC();
  const [fragmentKey, setFragmentKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(data.sandboxUrl);
  const [showReconnectAlert, setShowReconnectAlert] = useState(false);

  // Sync preview state when switching to a different fragment/project
  useEffect(() => {
    setCurrentUrl(data.sandboxUrl);
    setFragmentKey((prev) => prev + 1);
    setShowReconnectAlert(false);
  }, [data.id, data.sandboxUrl]);

  const reconnectMutation = useMutation(
    trpc.fragments.getOrRecreateSandbox.mutationOptions({
      onSuccess: (result) => {
        setCurrentUrl(result.url);
        setFragmentKey((prev) => prev + 1);
        setShowReconnectAlert(false);
        
        if (result.isNew) {
          toast.success(result.message);
        } else {
          toast.info(result.message);
        }
      },
      onError: (error) => {
        toast.error(`Failed to reconnect: ${error.message}`);
        setShowReconnectAlert(true);
        
        
      },
    })
  );

  const onRefresh = () => {
    setFragmentKey((prev) => prev + 1);
  };

  const handleReconnect = async () => {
    await reconnectMutation.mutateAsync({ fragmentId: data.id });
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(currentUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleIframeError = () => {
    // Show reconnect alert when iframe fails to load
    setShowReconnectAlert(true);
  };

  return (
    <div className="flex flex-col w-full h-full">
      <div className="p-2 border-b bg-sidebar flex items-center gap-2">
        <Hint text="Refresh preview" side="bottom" align="start">
          <Button 
            size="sm" 
            variant="outline" 
            onClick={onRefresh}
            disabled={reconnectMutation.isPending}
          >
            <RefreshCcwIcon className={reconnectMutation.isPending ? "animate-spin" : ""} />
          </Button>
        </Hint>

        <Hint text="Reconnect sandbox" side="bottom" align="start">
          <Button
            size="sm"
            variant="outline"
            onClick={handleReconnect}
            disabled={reconnectMutation.isPending}
            className="bg-green-500/10 hover:bg-green-500/20 text-green-700 dark:text-green-400 border-green-500/30"
          >
            {reconnectMutation.isPending ? (
              <>
                <RefreshCcwIcon className="animate-spin" />
                Reconnecting...
              </>
            ) : (
              <>
                <RefreshCcwIcon />
                Reconnect
              </>
            )}
          </Button>
        </Hint>

        <Hint text="Click to copy URL" side="bottom">
          <Button
            size="sm"
            variant="outline"
            onClick={handleCopy}
            className="flex-1 justify-start text-start font-normal"
            disabled={!currentUrl || copied}
          >
            <span className="truncate">{currentUrl}</span>
          </Button>
        </Hint>

        <Hint text="Open in new tab" side="bottom" align="start">
          <Button
            size="sm"
            disabled={!currentUrl}
            variant="outline"
            onClick={() => {
              if (!currentUrl) return;
              window.open(currentUrl, "_blank");
            }}
          >
            <ExternalLinkIcon />
          </Button>
        </Hint>
      </div>

      {showReconnectAlert && (
        <Alert variant="destructive" className="m-2">
          <AlertCircleIcon className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>Sandbox may be unavailable. Click reconnect to recreate it.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={handleReconnect}
              disabled={reconnectMutation.isPending}
            >
              Reconnect Now
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <iframe
        key={fragmentKey}
        className="h-full w-full"
        sandbox="allow-forms allow-scripts allow-same-origin"
        loading="lazy"
        src={currentUrl}
        onError={handleIframeError}
      />
    </div>
  );
}
