"use client";

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export default function Calculator() {
  const [display, setDisplay] = useState('0');
  const [previousValue, setPreviousValue] = useState<number | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [waitingForOperand, setWaitingForOperand] = useState(false);

  const inputNumber = (num: string) => {
    if (waitingForOperand) {
      setDisplay(num);
      setWaitingForOperand(false);
    } else {
      setDisplay(display === '0' ? num : display + num);
    }
  };

  const inputOperation = (nextOperation: string) => {
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
      case '+':
        return firstValue + secondValue;
      case '-':
        return firstValue - secondValue;
      case '*':
        return firstValue * secondValue;
      case '/':
        return firstValue / secondValue;
      case '=':
        return secondValue;
      default:
        return secondValue;
    }
  };

  const performCalculation = () => {
    const inputValue = parseFloat(display);

    if (previousValue !== null && operation) {
      const newValue = calculate(previousValue, inputValue, operation);
      setDisplay(String(newValue));
      setPreviousValue(null);
      setOperation(null);
      setWaitingForOperand(true);
    }
  };

  const clearAll = () => {
    setDisplay('0');
    setPreviousValue(null);
    setOperation(null);
    setWaitingForOperand(false);
  };

  const clearEntry = () => {
    setDisplay('0');
  };

  const inputDecimal = () => {
    if (waitingForOperand) {
      setDisplay('0.');
      setWaitingForOperand(false);
    } else if (display.indexOf('.') === -1) {
      setDisplay(display + '.');
    }
  };

  const deleteLastDigit = () => {
    if (display.length > 1) {
      setDisplay(display.slice(0, -1));
    } else {
      setDisplay('0');
    }
  };

  const buttonClass = "h-12 text-lg font-semibold transition-all duration-200 hover:scale-105 active:scale-95";

  return (
    <Card className="w-full max-w-md mx-auto shadow-2xl border-0 bg-gradient-to-br from-gray-50 to-gray-100">
      <CardHeader className="pb-4">
        <CardTitle className="text-2xl font-bold text-center text-gray-800">Calculator</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Display */}
        <div className="relative">
          <Input
            value={display}
            readOnly
            className="text-right text-2xl font-mono h-16 bg-gray-900 text-white border-0 rounded-lg shadow-inner"
          />
          {operation && (
            <div className="absolute top-2 right-2 text-xs text-gray-400">
              {operation}
            </div>
          )}
        </div>

        {/* Button Grid */}
        <div className="grid grid-cols-4 gap-3">
          {/* Row 1 */}
          <Button
            variant="outline"
            onClick={clearAll}
            className={`${buttonClass} col-span-2 border-red-200 text-red-600 hover:bg-red-50`}
          >
            AC
          </Button>
          <Button
            variant="outline"
            onClick={clearEntry}
            className={`${buttonClass} border-orange-200 text-orange-600 hover:bg-orange-50`}
          >
            CE
          </Button>
          <Button
            variant="outline"
            onClick={deleteLastDigit}
            className={`${buttonClass} border-gray-200 text-gray-600 hover:bg-gray-50`}
          >
            ⌫
          </Button>

          {/* Row 2 */}
          <Button
            variant="outline"
            onClick={() => inputNumber('7')}
            className={buttonClass}
          >
            7
          </Button>
          <Button
            variant="outline"
            onClick={() => inputNumber('8')}
            className={buttonClass}
          >
            8
          </Button>
          <Button
            variant="outline"
            onClick={() => inputNumber('9')}
            className={buttonClass}
          >
            9
          </Button>
          <Button
            variant="outline"
            onClick={() => inputOperation('/')}
            className={`${buttonClass} border-blue-200 text-blue-600 hover:bg-blue-50`}
          >
            ÷
          </Button>

          {/* Row 3 */}
          <Button
            variant="outline"
            onClick={() => inputNumber('4')}
            className={buttonClass}
          >
            4
          </Button>
          <Button
            variant="outline"
            onClick={() => inputNumber('5')}
            className={buttonClass}
          >
            5
          </Button>
          <Button
            variant="outline"
            onClick={() => inputNumber('6')}
            className={buttonClass}
          >
            6
          </Button>
          <Button
            variant="outline"
            onClick={() => inputOperation('*')}
            className={`${buttonClass} border-blue-200 text-blue-600 hover:bg-blue-50`}
          >
            ×
          </Button>

          {/* Row 4 */}
          <Button
            variant="outline"
            onClick={() => inputNumber('1')}
            className={buttonClass}
          >
            1
          </Button>
          <Button
            variant="outline"
            onClick={() => inputNumber('2')}
            className={buttonClass}
          >
            2
          </Button>
          <Button
            variant="outline"
            onClick={() => inputNumber('3')}
            className={buttonClass}
          >
            3
          </Button>
          <Button
            variant="outline"
            onClick={() => inputOperation('-')}
            className={`${buttonClass} border-blue-200 text-blue-600 hover:bg-blue-50`}
          >
            −
          </Button>

          {/* Row 5 */}
          <Button
            variant="outline"
            onClick={() => inputNumber('0')}
            className={`${buttonClass} col-span-2`}
          >
            0
          </Button>
          <Button
            variant="outline"
            onClick={inputDecimal}
            className={buttonClass}
          >
            .
          </Button>
          <Button
            onClick={performCalculation}
            className={`${buttonClass} bg-blue-600 text-white hover:bg-blue-700 shadow-lg`}
          >
            =
          </Button>
        </div>

        {/* Additional Info */}
        <div className="text-center text-xs text-gray-500 mt-4">
          Simple Calculator • Press buttons or use keyboard
        </div>
      </CardContent>
    </Card>
  );
}