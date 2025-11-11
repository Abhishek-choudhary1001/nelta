import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface CalculatorButtonProps {
  children: React.ReactNode
  onClick: () => void
  className?: string
  variant?: "default" | "outline" | "secondary" | "destructive" | "ghost"
}

export function CalculatorButton({ 
  children, 
  onClick, 
  className,
  variant = "default"
}: CalculatorButtonProps) {
  return (
    <Button
      onClick={onClick}
      variant={variant}
      className={cn(
        "h-14 text-lg font-semibold transition-all duration-150",
        "bg-slate-700/50 hover:bg-slate-600/50 text-white border-slate-600",
        "active:scale-95 hover:shadow-lg",
        "rounded-lg backdrop-blur-sm",
        className
      )}
    >
      {children}
    </Button>
  )
}