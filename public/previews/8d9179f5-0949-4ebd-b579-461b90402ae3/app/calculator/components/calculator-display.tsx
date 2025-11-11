interface CalculatorDisplayProps {
  value: string
  operation: string | null
}

export function CalculatorDisplay({ value, operation }: CalculatorDisplayProps) {
  return (
    <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-600">
      {operation && (
        <div className="text-slate-400 text-sm text-right mb-1">
          {operation}
        </div>
      )}
      <div className="text-right">
        <div className="text-3xl font-mono font-bold text-white break-all">
          {value}
        </div>
        {value.length > 10 && (
          <div className="text-xs text-slate-400 mt-1">
            Large number
          </div>
        )}
      </div>
    </div>
  )
}