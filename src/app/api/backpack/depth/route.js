import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import axios from 'axios';
import { BACKPACK_API_URL } from '../../../../webhelpers/constants';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol');
  const headersList = await headers();
  const forwardedFor = headersList.get('x-forwarded-for');
  const realIp = headersList.get('x-real-ip');
  const clientIp = forwardedFor?.split(',')[0] || realIp || 'unknown';
  try {
    const response = await axios.get(`${BACKPACK_API_URL}/depth`, {
      params: { symbol },
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': clientIp,
        'X-Real-IP': clientIp,
      }
    });
    return NextResponse.json(response.data);
  } catch (error) {
    console.error('Error proxying Backpack API request:', error);
    return NextResponse.json(
      { error: 'Failed to fetch data from Backpack' },
      { status: 500 }
    );
  }
} 