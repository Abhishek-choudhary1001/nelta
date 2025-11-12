"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Delete, Equal, Minus, Plus, X, Divide } from "lucide-react";

export default function Calculator() {
  const [display, setDisplay] = useState("0");
  const [previousValue, setPreviousValue] = useState<number | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [waitingForOperand, setWaitingForOperand] = useState(false);

  const inputNumber = (num: string) => {
    if (waitingForOperand) {
      setDisplay(num);
      setWaitingForOperand(false);
    } else {
      setDisplay(display === "0" ? num : display + num);
    }
  };

  const inputDecimal = () => {
    if (waitingForOperand) {
      setDisplay("0.");
      setWaitingForOperand(false);
    } else if (display.indexOf(".") === -1) {
      setDisplay(display + ".");
    }
  };

  const clear = () => {
    setDisplay("0");
    setPreviousValue(null);
    setOperation(null);
    setWaitingForOperand(false);
  };

  const performOperation = (nextOperation: string) => {
    const inputValue = parseFloat(display);

    if (previousValue === null) {
      setPreviousValue(inputValue);
    } else if (operation) {
      const currentValue = previousValue || 0;
      const newValue = calculate(currentValue, inputValue, operation);

      setDisplay(String(newValue));
      setPreviousValue(newValue);
    }

    setWaitingForOperand(true);
    setOperation(nextOperation);
  };

  const calculate = (firstValue: number, secondValue: number, operation: string): number => {
    switch (operation) {
      case "+":
        return firstValue + secondValue;
      case "-":
        return firstValue - secondValue;
      case "×":
        return firstValue * secondValue;
      case "÷":
        return firstValue / secondValue;
      case "=":
        return secondValue;
      default:
        return secondValue;
    }
  };

  const handleEqual = () => {
    if (operation && previousValue !== null) {
      const inputValue = parseFloat(display);
      const newValue = calculate(previousValue, inputValue, operation);
      setDisplay(String(newValue));
      setPreviousValue(null);
      setOperation(null);
      setWaitingForOperand(true);
    }
  };

  const handleDelete = () => {
    if (display.length > 1) {
      setDisplay(display.slice(0, -1));
    } else {
      setDisplay("0");
    }
  };

  const getButtonVariant = (type: "number" | "operation" | "special") => {
    switch (type) {
      case "operation":
        return "default";
      case "special":
        return "secondary";
      default:
        return "outline";
    }
  };

  const buttonClass = "h-12 text-lg font-semibold transition-all hover:scale-105 active:scale-95";

  return (
    <div className="w-full max-w-sm mx-auto bg-white rounded-2xl shadow-2xl p-6 border">
      {/* Header */}
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Calculator</h1>
        <p className="text-sm text-gray-500">Simple & Clean Design</p>
      </div>

      {/* Display */}
      <div className="mb-6">
        <div className="bg-gray-50 rounded-lg p-4 border-2 border-gray-100">
          <div className="text-right">
            <div className="text-3xl font-mono font-bold text-gray-800 break-all">
              {display}
            </div>
            {operation && previousValue !== null && (
              <div className="text-sm text-gray-500 mt-1">
                {previousValue} {operation}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Buttons Grid */}
      <div className="grid grid-cols-4 gap-3">
        {/* Row 1 */}
        <Button
          onClick={clear}
          variant={getButtonVariant("special")}
          className={cn(buttonClass, "col-span-2 bg-red-500 hover:bg-red-600 text-white border-red-500")}
        >
          Clear
        </Button>
        <Button
          onClick={handleDelete}
          variant={getButtonVariant("special")}
          className={cn(buttonClass, "bg-orange-500 hover:bg-orange-600 text-white border-orange-500")}
        >
          <Delete className="w-5 h-5" />
        </Button>
        <Button
          onClick={() => performOperation("÷")}
          variant={getButtonVariant("operation")}
          className={cn(buttonClass, "bg-blue-500 hover:bg-blue-600 text-white border-blue-500")}
        >
          <Divide className="w-5 h-5" />
        </Button>

        {/* Row 2 */}
        <Button
          onClick={() => inputNumber("7")}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          7
        </Button>
        <Button
          onClick={() => inputNumber("8")}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          8
        </Button>
        <Button
          onClick={() => inputNumber("9")}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          9
        </Button>
        <Button
          onClick={() => performOperation("×")}
          variant={getButtonVariant("operation")}
          className={cn(buttonClass, "bg-blue-500 hover:bg-blue-600 text-white border-blue-500")}
        >
          <X className="w-5 h-5" />
        </Button>

        {/* Row 3 */}
        <Button
          onClick={() => inputNumber("4")}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          4
        </Button>
        <Button
          onClick={() => inputNumber("5")}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          5
        </Button>
        <Button
          onClick={() => inputNumber("6")}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          6
        </Button>
        <Button
          onClick={() => performOperation("-")}
          variant={getButtonVariant("operation")}
          className={cn(buttonClass, "bg-blue-500 hover:bg-blue-600 text-white border-blue-500")}
        >
          <Minus className="w-5 h-5" />
        </Button>

        {/* Row 4 */}
        <Button
          onClick={() => inputNumber("1")}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          1
        </Button>
        <Button
          onClick={() => inputNumber("2")}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          2
        </Button>
        <Button
          onClick={() => inputNumber("3")}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          3
        </Button>
        <Button
          onClick={() => performOperation("+")}
          variant={getButtonVariant("operation")}
          className={cn(buttonClass, "bg-blue-500 hover:bg-blue-600 text-white border-blue-500")}
        >
          <Plus className="w-5 h-5" />
        </Button>

        {/* Row 5 */}
        <Button
          onClick={() => inputNumber("0")}
          variant={getButtonVariant("number")}
          className={cn(buttonClass, "col-span-2")}
        >
          0
        </Button>
        <Button
          onClick={inputDecimal}
          variant={getButtonVariant("number")}
          className={buttonClass}
        >
          .
        </Button>
        <Button
          onClick={handleEqual}
          variant={getButtonVariant("operation")}
          className={cn(buttonClass, "bg-green-500 hover:bg-green-600 text-white border-green-500")}
        >
          <Equal className="w-5 h-5" />
        </Button>
      </div>

      {/* Footer */}
      <div className="mt-6 text-center text-xs text-gray-400">
        Built with React & Tailwind CSS
      </div>
    </div>
  );
}