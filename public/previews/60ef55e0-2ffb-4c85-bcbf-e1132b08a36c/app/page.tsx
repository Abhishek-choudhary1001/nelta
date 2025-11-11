"use client"

import { useState } from "react"

export default function Calculator() {
  const [display, setDisplay] = useState("0")
  const [previousValue, setPreviousValue] = useState<number | null>(null)
  const [operator, setOperator] = useState<string | null>(null)
  const [waitingForOperand, setWaitingForOperand] = useState(false)

  const inputNumber = (num: string) => {
    if (waitingForOperand) {
      setDisplay(num)
      setWaitingForOperand(false)
    } else {
      setDisplay(display === "0" ? num : display + num)
    }
  }

  const inputDecimal = () => {
    if (waitingForOperand) {
      setDisplay("0.")
      setWaitingForOperand(false)
    } else if (display.indexOf(".") === -1) {
      setDisplay(display + ".")
    }
  }

  const clear = () => {
    setDisplay("0")
    setPreviousValue(null)
    setOperator(null)
    setWaitingForOperand(false)
  }

  const performOperation = (nextOperator: string) => {
    const inputValue = parseFloat(display)

    if (previousValue === null) {
      setPreviousValue(inputValue)
    } else if (operator) {
      const currentValue = previousValue || 0
      const newValue = calculate(currentValue, inputValue, operator)

      setDisplay(String(newValue))
      setPreviousValue(newValue)
    }

    setWaitingForOperand(true)
    setOperator(nextOperator)
  }

  const calculate = (firstValue: number, secondValue: number, operator: string): number => {
    switch (operator) {
      case "+":
        return firstValue + secondValue
      case "-":
        return firstValue - secondValue
      case "×":
        return firstValue * secondValue
      case "÷":
        return firstValue / secondValue
      case "=":
        return secondValue
      default:
        return secondValue
    }
  }

  const handleEquals = () => {
    const inputValue = parseFloat(display)

    if (previousValue !== null && operator) {
      const newValue = calculate(previousValue, inputValue, operator)
      setDisplay(String(newValue))
      setPreviousValue(null)
      setOperator(null)
      setWaitingForOperand(true)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-400 to-purple-600 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm">
        <div className="mb-6">
          <div className="bg-gray-900 text-white text-right text-3xl font-mono p-4 rounded-2xl h-16 flex items-center justify-end overflow-hidden">
            {display}
          </div>
        </div>
        
        <div className="grid grid-cols-4 gap-3">
          {/* First Row */}
          <button
            onClick={clear}
            className="col-span-2 bg-red-500 hover:bg-red-600 text-white font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-lg"
          >
            Clear
          </button>
          <button
            onClick={() => performOperation("÷")}
            className="bg-orange-500 hover:bg-orange-600 text-white font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-lg"
          >
            ÷
          </button>
          <button
            onClick={() => performOperation("×")}
            className="bg-orange-500 hover:bg-orange-600 text-white font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-lg"
          >
            ×
          </button>

          {/* Second Row */}
          <button
            onClick={() => inputNumber("7")}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            7
          </button>
          <button
            onClick={() => inputNumber("8")}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            8
          </button>
          <button
            onClick={() => inputNumber("9")}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            9
          </button>
          <button
            onClick={() => performOperation("-")}
            className="bg-orange-500 hover:bg-orange-600 text-white font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-lg"
          >
            -
          </button>

          {/* Third Row */}
          <button
            onClick={() => inputNumber("4")}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            4
          </button>
          <button
            onClick={() => inputNumber("5")}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            5
          </button>
          <button
            onClick={() => inputNumber("6")}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            6
          </button>
          <button
            onClick={() => performOperation("+")}
            className="bg-orange-500 hover:bg-orange-600 text-white font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-lg"
          >
            +
          </button>

          {/* Fourth Row */}
          <button
            onClick={() => inputNumber("1")}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            1
          </button>
          <button
            onClick={() => inputNumber("2")}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            2
          </button>
          <button
            onClick={() => inputNumber("3")}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            3
          </button>
          <button
            onClick={handleEquals}
            className="row-span-2 bg-blue-500 hover:bg-blue-600 text-white font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-lg"
          >
            =
          </button>

          {/* Fifth Row */}
          <button
            onClick={() => inputNumber("0")}
            className="col-span-2 bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            0
          </button>
          <button
            onClick={inputDecimal}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 px-6 rounded-2xl text-lg transition-colors duration-200 shadow-md"
          >
            .
          </button>
        </div>
      </div>
    </div>
  )
}