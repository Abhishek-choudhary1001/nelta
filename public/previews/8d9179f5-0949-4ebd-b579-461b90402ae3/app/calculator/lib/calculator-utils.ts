export function calculate(firstValue: number, secondValue: number, operation: string): number {
  switch (operation) {
    case '+':
      return firstValue + secondValue
    case '-':
      return firstValue - secondValue
    case '*':
      return firstValue * secondValue
    case '/':
      return firstValue / secondValue
    default:
      return secondValue
  }
}

export function formatResult(value: number): string {
  if (isNaN(value) || !isFinite(value)) {
    return 'Error'
  }
  
  // Handle very large or very small numbers
  if (Math.abs(value) >= 1e15 || (Math.abs(value) < 1e-10 && value !== 0)) {
    return value.toExponential(10)
  }
  
  // Remove trailing zeros and unnecessary decimal points
  const result = parseFloat(value.toFixed(10))
  
  if (Math.abs(result) >= 1e12) {
    return result.toExponential(2)
  }
  
  if (Number.isInteger(result)) {
    return result.toString()
  }
  
  return result.toString()
}