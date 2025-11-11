"use client"

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CalculatorDisplay } from './components/calculator-display'
import { CalculatorButton } from './components/calculator-button'
import { calculate, formatResult } from './lib/calculator-utils'

export default function CalculatorPage() {
  const [display, setDisplay] = useState('0')
  const [previousValue, setPreviousValue] = useState<number | null>(null)
  const [operation, setOperation] = useState<string | null>(null)
  const [waitingForNewValue, setWaitingForNewValue] = useState(false)

  const inputNumber = (num: string) => {
    if (waitingForNewValue) {
      setDisplay(num)
      setWaitingForNewValue(false)
    } else {
      setDisplay(display === '0' ? num : display + num)
    }
  }

  const inputDecimal = () => {
    if (waitingForNewValue) {
      setDisplay('0.')
      setWaitingForNewValue(false)
    } else if (display.indexOf('.') === -1) {
      setDisplay(display + '.')
    }
  }

  const clear = () => {
    setDisplay('0')
    setPreviousValue(null)
    setOperation(null)
    setWaitingForNewValue(false)
  }

  const performOperation = (nextOperation: string) => {
    const inputValue = parseFloat(display)

    if (previousValue === null) {
      setPreviousValue(inputValue)
    } else if (operation) {
      const currentValue = previousValue || 0
      const newValue = calculate(currentValue, inputValue, operation)

      setDisplay(formatResult(newValue))
      setPreviousValue(newValue)
    }

    setWaitingForNewValue(true)
    setOperation(nextOperation)
  }

  const handleEquals = () => {
    const inputValue = parseFloat(display)

    if (previousValue !== null && operation) {
      const newValue = calculate(previousValue, inputValue, operation)
      setDisplay(formatResult(newValue))
      setPreviousValue(null)
      setOperation(null)
      setWaitingForNewValue(true)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">Calculator</h1>
          <p className="text-slate-400">A modern calculator with sleek design</p>
        </div>
        
        <Card className="bg-slate-800/50 backdrop-blur-lg border-slate-700 shadow-2xl">
          <div className="p-6">
            <CalculatorDisplay value={display} operation={operation} />
            
            <div className="grid grid-cols-4 gap-3 mt-6">
              {/* Row 1 */}
              <CalculatorButton 
                onClick={clear}
                className="col-span-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 border-red-500/30"
              >
                Clear
              </CalculatorButton>
              <CalculatorButton 
                onClick={() => setDisplay(display.slice(0, -1) || '0')}
                className="bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 border-orange-500/30"
              >
                ⌫
              </CalculatorButton>
              <CalculatorButton 
                onClick={() => performOperation('/')}
                className="bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border-blue-500/30"
              >
                ÷
              </CalculatorButton>

              {/* Row 2 */}
              <CalculatorButton onClick={() => inputNumber('7')}>7</CalculatorButton>
              <CalculatorButton onClick={() => inputNumber('8')}>8</CalculatorButton>
              <CalculatorButton onClick={() => inputNumber('9')}>9</CalculatorButton>
              <CalculatorButton 
                onClick={() => performOperation('*')}
                className="bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border-blue-500/30"
              >
                ×
              </CalculatorButton>

              {/* Row 3 */}
              <CalculatorButton onClick={() => inputNumber('4')}>4</CalculatorButton>
              <CalculatorButton onClick={() => inputNumber('5')}>5</CalculatorButton>
              <CalculatorButton onClick={() => inputNumber('6')}>6</CalculatorButton>
              <CalculatorButton 
                onClick={() => performOperation('-')}
                className="bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border-blue-500/30"
              >
                −
              </CalculatorButton>

              {/* Row 4 */}
              <CalculatorButton onClick={() => inputNumber('1')}>1</CalculatorButton>
              <CalculatorButton onClick={() => inputNumber('2')}>2</CalculatorButton>
              <CalculatorButton onClick={() => inputNumber('3')}>3</CalculatorButton>
              <CalculatorButton 
                onClick={() => performOperation('+')}
                className="bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border-blue-500/30"
              >
                +
              </CalculatorButton>

              {/* Row 5 */}
              <CalculatorButton 
                onClick={() => inputNumber('0')}
                className="col-span-2"
              >
                0
              </CalculatorButton>
              <CalculatorButton onClick={inputDecimal}>.</CalculatorButton>
              <CalculatorButton 
                onClick={handleEquals}
                className="bg-green-500/20 hover:bg-green-500/30 text-green-400 border-green-500/30"
              >
                =
              </CalculatorButton>
            </div>
          </div>
        </Card>
        
        <div className="text-center mt-6">
          <p className="text-slate-500 text-sm">
            Built with React, TypeScript & Tailwind CSS
          </p>
        </div>
      </div>
    </div>
  )
}